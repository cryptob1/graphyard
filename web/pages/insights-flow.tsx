import { useEffect, useState } from 'react';
import { classify, shippedThisWeek } from '../groups';
import { releaseView } from '../../src/model/release';
import { prSteps, stepIds, stepLabel, type StepId } from '../../src/model/pr-steps';
import { positionsAt, replayFrames, replaySeconds, replayWindowMs, transitionsFromRows, type ReplayFrame } from '../flow-replay';
import { formatDuration } from '../../src/model/duration';
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
 * The flow report the Flow panel's step medians, time split and daily landings read. It is read
 * on its own (GY-705), so the medians appear as soon as it answers and never wait on the replay rows.
 */
export async function readFlowReport(api: Dashboard['api']) {
  return (await api('analytics/flow?window=7')) ?? null;
}

/** The replay frames of the last day's recorded step moves, read page by page (`readStepRows`). */
export async function readReplay(api: Dashboard['api'], now: number) {
  const since = new Date(now - replayWindowMs).toISOString();
  const moves = await readStepRows(api, since);
  return { frames: replayFrames(transitionsFromRows(moves.rows), now), truncated: !moves.complete };
}

/**
 * What the Flow panel reads from the control plane: the flow report and the replay frames of the
 * last day's recorded step moves. The two reads settle independently (GY-705): a failed or slow
 * replay read never discards the report, and each failure is named on its own
 * (`reportError`, `replayError`, present only on a failed read). Tolerant of what a real board returns — a report without step
 * or throughput figures, a drill-down without rows — so an item with no observation, reviews or
 * candidate never stops the panel (GY-161, AC-12).
 */
export async function readFlow(api: Dashboard['api'], now: number) {
  const [flow, replay] = await Promise.allSettled([readFlowReport(api), readReplay(api, now)]);
  return {
    report: flow.status === 'fulfilled' ? flow.value : null,
    frames: replay.status === 'fulfilled' ? replay.value.frames : [],
    truncated: replay.status === 'fulfilled' && replay.value.truncated,
    ...(flow.status === 'rejected' ? { reportError: (flow.reason as Error).message } : {}),
    ...(replay.status === 'rejected' ? { replayError: (replay.reason as Error).message } : {}),
  };
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
  const landed: { bucket: string; delivered: number; researched: number | null; covered: boolean }[] = (Array.isArray(report?.throughput) ? report.throughput : []).slice(-7)
    .map((entry: any) => ({ bucket: entry.bucket, delivered: entry.delivered, researched: typeof entry.researched === 'number' ? entry.researched : null, covered: !coverage?.stale && !coverage?.population && (typeof entry.covered === 'boolean' ? entry.covered : Math.min(Date.parse(entry.bucket) + day, Number.isNaN(end) ? Infinity : end) <= until) }));
  const peak = Math.max(1, ...landed.filter(entry => entry.covered).map(entry => entry.delivered));
  return <section className="panel" aria-label="Landed per day"><h2>Landed on main per day <small>last 7 days, UTC</small></h2>
    {coverage && <p className="notice" role="status" data-flow="coverage">{coverage.statement}</p>}
    {landed.length ? <div className="landed-bars">{landed.map(entry => entry.covered
      ? <div key={entry.bucket} className="landed-day" data-bucket={entry.bucket} data-researched={entry.researched ?? undefined}
        title={`${entry.delivered} on ${entry.bucket.slice(0, 10)}${entry.researched !== null ? `, ${entry.researched} built from a research brief` : ''}`}>
        <span>{entry.delivered}</span><span className="landed-bar" style={{ height: `${Math.round(entry.delivered / peak * 160)}px` }}/><small>{new Date(entry.bucket).toISOString().slice(5, 10)}</small>
      </div>
      : <div key={entry.bucket} className="landed-day uncovered" data-bucket={entry.bucket} data-uncovered="true" title={`${entry.bucket.slice(0, 10)} was not read`}>
        <span>—</span><small>{new Date(entry.bucket).toISOString().slice(5, 10)} not read</small>
      </div>)}</div> : <p className="muted">{report ? coverage ? 'No day of this window was read.' : 'Nothing landed in this window.' : 'Reading the recorded deliveries…'}</p>}
  </section>;
}

const perItem = (summary: any) => summary && typeof summary.average === 'number' ? summary.average.toFixed(1) : '—';
/**
 * Research (GY-434): the step's runs over the window — briefs, runs that ended without one, and the
 * median time from a run's start to its brief — and its effect: rework rounds and review findings
 * per feature for features with a recorded brief against features without one. The figures
 * are the flow report's own (`research`), computed from the recorded research facts.
 */
export function ResearchEffect({ report }: { report: any }) {
  const research = report?.research;
  if (!research) return <section className="panel" aria-label="Research"><h2>Research</h2><p className="muted">{report ? 'No research run was recorded in this window.' : 'Reading the recorded research runs…'}</p></section>;
  const { researched, unresearched } = research.effect ?? {};
  const days = Number(report?.window?.days) || 7;
  return <section className="panel research-effect" aria-label="Research"><h2>Research <small>last {days} {days === 1 ? 'day' : 'days'}</small></h2>
    <p data-research="runs">{research.runs} {research.runs === 1 ? 'run' : 'runs'} · {research.briefs} {research.briefs === 1 ? 'brief' : 'briefs'} · {research.skipped} without a brief · median {minutes(research.duration?.medianMs ?? null)}</p>
    <table className="research-effect-table"><thead><tr><th scope="col">Features</th><th scope="col">Items</th><th scope="col">Rework rounds per item</th><th scope="col">Review findings per item</th></tr></thead>
      <tbody>
        <tr data-cohort="researched"><th scope="row">Researched</th><td>{researched?.items ?? 0}</td><td>{perItem(researched?.reworkRounds)}</td><td>{perItem(researched?.reviewFindings)}</td></tr>
        <tr data-cohort="unresearched"><th scope="row">Not researched</th><td>{unresearched?.items ?? 0}</td><td>{perItem(unresearched?.reworkRounds)}</td><td>{perItem(unresearched?.reviewFindings)}</td></tr>
      </tbody></table>
  </section>;
}

/** Fewer samples than this make a step's median sparse (src/flow-analytics.ts `sparseSampleSize`). */
const sparseSamples = 5;
export interface StepTime { step: StepId; n: number; medianMs: number | null; marked: 'sparse' | 'partial' | null }
/**
 * Each step's median time from the report's step dwell, and whether it may be read as fact. A step
 * with fewer than five samples is `sparse`; every step is `partial` when the report did not read the
 * whole window's gate facts or merges, or its record lags the ledger. A marked step shows its sample count and
 * marker and takes no share of the time split, so a median from two stays is never drawn as the week's.
 */
export function stepTimes(report: any): { steps: StepTime[]; partial: boolean; coverage: ReturnType<typeof flowCoverage> } {
  const coverage = flowCoverage(report);
  // Step times read from gate facts or merges the report did not reach (a merge past its read never
  // moves the item to Deploy), or from a lagging record, are not the week's.
  const to = Date.parse(report?.window?.to ?? '');
  const partial = !!coverage && (coverage.stale || coverage.population || Math.min(readUntil(report, 'gates.changed'), readUntil(report, 'merged')) < to);
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
  return { byGroup, release, entries, outside: { upNext: byGroup['up-next'].length - rework.length } };
}

/** The dots one Now column shows before its '+N more' control (GY-705); the step header above it carries the column's full count. */
export const nowColumnLimit = 12;
/** How many Now dots wrap into one row of a step column. */
export const nowPerRow = 2;
const nowRowHeight = 22;
/** Where the `index`th dot of a step column stands: its wrapped row, and its slot in that row. */
const nowSlot = (step: StepId, index: number) => `${(stepIds.indexOf(step) + (index % nowPerRow + 0.5) / nowPerRow) / stepIds.length * 100}%`;
const nowTop = (row: number) => `${10 + row * nowRowHeight}px`;

/**
 * The Now view (GY-705): every item in the flow at its true step, its column wrapping the dots
 * `nowPerRow` to a row and showing at most `nowColumnLimit` of them before a '+N more' control
 * that expands the column (and folds it again). The lane is only as tall as its fullest shown
 * column, and CSS caps it (an expanded column scrolls inside it), so a busy step never makes the
 * panel tall. A dot is keyed by its item, so it moves only when that item changes step.
 */
export function NowLane({ entries, blocked, expanded, onToggle, onSelect }: {
  entries: ReturnType<typeof flowNow>['entries'];
  blocked: ReadonlySet<string>;
  expanded: ReadonlySet<StepId>;
  onToggle: (step: StepId) => void;
  onSelect: (id: string) => void;
}) {
  const columns = stepIds.map(step => {
    const all = entries.filter(entry => entry.steps.current === step);
    const open = expanded.has(step) && all.length > nowColumnLimit;
    return { step, all, open, shown: open ? all : all.slice(0, nowColumnLimit) };
  });
  // A column with more than the limit gives its control a row of its own under its dots.
  const rows = Math.max(1, ...columns.map(({ all, shown }) => Math.ceil(shown.length / nowPerRow) + (all.length > nowColumnLimit ? 1 : 0)));
  return <div className="flow-lane now-lane" data-flow="now" style={{ height: `${20 + rows * nowRowHeight}px` }}>
    {columns.flatMap(({ step, all, open, shown }) => [
      ...shown.map(({ item, steps }, index) => <button type="button" key={item.id} className={`now-dot group-${blocked.has(item.id) ? 'blocked' : 'moving'}`} data-step={steps.current} data-key={item.key}
        data-row={Math.floor(index / nowPerRow)} style={{ left: nowSlot(step, index), top: nowTop(Math.floor(index / nowPerRow)) }} title={`${item.key}: ${steps.label}`} aria-label={`${item.key} at ${stepLabel[step]}: ${steps.label}`} onClick={() => onSelect(item.id)}><span className="mono">{item.key}</span></button>),
      all.length > nowColumnLimit && <button type="button" key={`more-${step}`} className="now-more" data-step={step} data-hidden={open ? 0 : all.length - shown.length} aria-expanded={open}
        style={{ left: column(step), top: nowTop(Math.ceil(shown.length / nowPerRow)) }} aria-label={open ? `Show fewer items at ${stepLabel[step]}` : `Show all ${all.length} items at ${stepLabel[step]}`}
        onClick={() => onToggle(step)}>{open ? 'Show fewer' : <>+{all.length - shown.length}<span className="now-more-word"> more</span></>}</button>,
    ])}
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
    <div className="kpi" data-kpi="moving"><span>Moving now</span><strong>{moving}</strong><small>research to live</small></div>
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

/** The clock the replay runs on: the browser's animation frames, or a test's hand-advanced one. */
export type FrameClock = { now(): number; request(tick: (at: number) => void): number; cancel(frame: number): void };
const browserClock: FrameClock = { now: () => performance.now(), request: tick => requestAnimationFrame(tick), cancel: frame => cancelAnimationFrame(frame) };

/**
 * One run of the replay (GY-204): from position `t` it advances with the clock, reaching the end
 * `replaySeconds` after a start from the first frame, then stops. It runs only while `playing` —
 * nothing starts it but the viewer's press — and never under reduced motion. Returns the stop.
 */
export function replayLoop(playing: boolean, t: number, clock: FrameClock, setT: (t: number) => void, setPlaying: (playing: boolean) => void): (() => void) | undefined {
  // Under reduced motion the replay never animates: the slider steps through it instead.
  if (!playing || reducedMotion()) return;
  let frame = 0; const started = clock.now() - t * replaySeconds * 1000;
  const tick = (at: number) => { const next = Math.min(1, (at - started) / (replaySeconds * 1000)); setT(next); if (next < 1) frame = clock.request(tick); else setPlaying(false); };
  frame = clock.request(tick);
  return () => clock.cancel(frame);
}

const PlayIcon = () => <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>;
const ReplayIcon = () => <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false"><path d="M12 5a7 7 0 1 1-6.6 4.7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/><path d="M4.2 4.5v5.6h5.6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>;

/**
 * The replay, played like a video (GY-204): it waits at its first frame under a large play button
 * and runs once, over `replaySeconds`, only when that button is pressed. While it plays the button
 * gives way to a small pause control; at the end it holds the last frame under a replay button.
 * The position slider below it follows playback and can be dragged to scrub, which pauses the
 * replay at that point; pressing play then resumes from there. Under prefers-reduced-motion there
 * is no button: the replay shows its last frame and the slider steps through it. `initial` sets
 * where it stands on first render.
 */
export function ReplaySection({ frames, truncated, initial, clock = browserClock }: { frames: ReplayFrame[]; truncated: boolean; initial?: { t: number; playing: boolean }; clock?: FrameClock }) {
  const [t, setT] = useState(initial?.t ?? (reducedMotion() ? 1 : 0));
  const [playing, setPlaying] = useState(initial?.playing ?? false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => replayLoop(playing, t, clock, setT, setPlaying), [playing]);
  const ended = t >= 1;
  return <>
    <div className="replay-stage" data-playing={playing} data-position={t}>
      <ReplayLane frames={frames} t={t}/>
      {!reducedMotion() && <button type="button" className="replay-overlay" hidden={playing} data-replay={ended ? 'replay' : 'play'} aria-label={ended ? 'Replay the last 24 hours' : 'Play the last 24 hours'} onClick={() => { if (t >= 1) setT(0); setPlaying(true); }}>
        <span className="replay-disc">{ended ? <ReplayIcon/> : <PlayIcon/>}</span>
      </button>}
    </div>
    <div className="replay-controls">
      <span>24 h ago</span>
      {/* The slider tracks playback and scrubs it: dragging pauses the replay at the chosen point (GY-288). */}
      <input type="range" min={0} max={1000} value={Math.round(t * 1000)} aria-label="Replay position" onChange={e => { setPlaying(false); setT(Number(e.target.value) / 1000); }}/>
      <span>now</span>
      {playing && <button type="button" className="text-button replay-pause" aria-label="Pause the replay" onClick={() => setPlaying(false)}>Pause</button>}
      {truncated && <small>Only the first rows of the recorded history were returned.</small>}
    </div>
  </>;
}

/**
 * Insights (GY-161, one page since GY-168 as design/dashboard/Insights.dc.html draws it): the
 * headline numbers, then the Flow panel, then landed per day beside where the time goes, and the
 * shipping pulse and flow analytics detail folded behind one Show details toggle. The detail is
 * mounted only once opened, so a visit that never opens it reads none of its reports.
 *
 * The Flow panel is research to live, one column per pull-request step.
 *
 * - **Now** places every open item at its true step (`prSteps`, the same reading the Work page
 *   draws) straight from the work snapshot, before either read below answers. A dot is keyed by its
 *   item, so it moves only when that item's step changes. A column wraps its dots and shows at most
 *   `nowColumnLimit` before a '+N more' control, so a busy step never makes the panel tall (GY-705).
 * - **Last 24 hours, replayed** plays the recorded step changes (web/flow-replay.ts) in
 *   twenty seconds, once the viewer presses its play button; a return to Build is rework and is drawn red.
 * - **Landed on main per day** and **where the time goes** are the flow report's own daily
 *   deliveries (with how many were built from a research brief) and per-step dwell medians,
 *   computed from the same recorded step moves; **Research** is the research step's runs and its
 *   effect on rework and review findings (GY-434). The report and the replay rows are read
 *   independently: the medians render as soon as the report answers, and a failed or slow replay
 *   read shows its own notice without blanking them (GY-705).
 *
 * Every animation stops under prefers-reduced-motion: the replay then shows its last frame with
 * a slider to step through it in place of the play button, and the CSS rule turns the dots' movement off.
 */
export default function InsightsPage({ work, status, api, token, observedAt, setSelected }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const [report, setReport] = useState<any>(null);
  const [frames, setFrames] = useState<ReplayFrame[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [reportError, setReportError] = useState('');
  const [replayError, setReplayError] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<StepId>>(() => new Set());
  const [detailed, setDetailed] = useState(false);
  const pulse = usePulse(token);
  useEffect(() => {
    let active = true;
    // The report and the replay rows are read independently (GY-705): the medians render the
    // moment the report answers, and a failed or slow replay read never blanks them.
    readFlowReport(api).then(flow => { if (active) setReport(flow); }, (e: Error) => { if (active) setReportError(e.message); });
    // Loading only shows the replay: it waits, still at its first frame, for the viewer to press play.
    readReplay(api, now).then(replay => { if (active) { setFrames(replay.frames); setTruncated(replay.truncated); } }, (e: Error) => { if (active) setReplayError(e.message); });
    return () => { active = false; };
    // Read once per visit: the replay is the last day's record, not a live feed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The page reads the release view flowNow classified with, so every figure uses one reading.
  const { byGroup, release, entries: now7, outside } = flowNow(work, now, status);
  // Per-step medians come from the same recorded step moves the replay plays (the report's stepDwell);
  // the slowest step is named only among those with enough samples over a fully read window.
  const count = (step: StepId) => now7.filter(entry => entry.steps.current === step).length;
  const times = new Map(stepTimes(report).steps.map(entry => [entry.step, entry]));
  const counted = [...times.values()].filter(entry => !entry.marked && entry.medianMs !== null && entry.medianMs > 0);
  const slowest = counted.length ? counted.reduce((a, b) => b.medianMs! > a.medianMs! ? b : a).step : null;
  return <>
    <div className="page-heading"><div><h1>Insights</h1><p className="summary">How work moves from research to live. {now7.length} {now7.length === 1 ? 'item is' : 'items are'} in the flow now.</p></div></div>
    <Headline shipped={shippedThisWeek(work, now, release).length} moving={byGroup.moving.length} waiting={byGroup['needs-you']} now={now} pulse={pulse} requests={status?.humanOnly}/>
    {replayError && <p className="notice" role="status" data-flow="replay-error">The recorded history could not be read: {replayError}. The Now view below is live, and the step medians come from the flow report.</p>}
    {reportError && <p className="notice" role="status" data-flow="report-error">The flow report could not be read: {reportError}. The step medians and where the time goes are unavailable until it answers; the Now view below is live.</p>}
    <section className="flow-panel" aria-label="Flow">
      <div className="flow-subhead flow-title"><h2>Flow</h2><span>Research to live, one column per step.</span></div>
      <div className="flow-columns-head">{stepIds.map(step => <div key={step} className={step === slowest ? 'flow-step slowest' : 'flow-step'} data-count={count(step)}>
        <strong>{stepLabel[step]}</strong><span>{count(step)} now<span className="flow-median" data-median={times.get(step)?.medianMs ?? ''}> · median {minutes(times.get(step)?.medianMs)}</span></span><StepMarker time={times.get(step)!}/>{step === slowest && <small>slowest step</small>}
      </div>)}</div>
      <div className="flow-subhead"><span className="dot live"/><h3>Now</h3><span>Real time. A dot moves only when its item changes step.</span>
        <p className="outside">Waiting outside the flow: {byGroup['needs-you'].length} {byGroup['needs-you'].length === 1 ? 'needs' : 'need'} you · {outside.upNext} up next · {byGroup.backlog.length} in backlog</p></div>
      <NowLane entries={now7} blocked={new Set(byGroup.blocked.map(item => item.id))} expanded={expanded} onSelect={setSelected}
        onToggle={step => setExpanded(previous => { const next = new Set(previous); if (!next.delete(step)) next.add(step); return next; })}/>
      <div className="flow-subhead"><h3>Last 24 hours, replayed</h3><span>Recorded step changes played back in {replaySeconds} s. Red dots went back to Build for rework.</span></div>
      {frames === null ? <p className="muted flow-wait">{replayError ? 'No recorded history to replay.' : 'Reading the recorded step changes…'}</p>
        : frames.length === 0 ? <p className="muted flow-wait">No item changed step in the last 24 hours.</p>
          : <ReplaySection frames={frames} truncated={truncated}/>}
    </section>
    <div className="insight-charts">
      <LandedPerDay report={report}/>
      <WhereTimeGoes report={report}/>
      <ResearchEffect report={report}/>
    </div>
    <details className="insight-details" onToggle={event => { if (event.currentTarget.open) setDetailed(true); }}><summary>Show details</summary>
      {detailed && <div className="insight-details-body"><InsightsDetails pulse={pulse} repository={status?.repository} api={api} token={token} canAudit={['admin', 'coordinator', 'producer'].includes(status?.actor?.role)}/></div>}
    </details>
  </>;
}
