import { useEffect, useRef, useState } from 'react';
import type { Goal } from '../../src/model/goal.js';
import type { Work } from '../../src/model/work.js';
import { planStateColor, planFlowchart, type PlanState } from '../visual-plan';

/**
 * One goal's picture page (GY-2011): the plan summary, approved outcomes as short cards, an SVG
 * flowchart of the plan (boxes coloured Todo/Doing/Checking/Done, arrows for dependsOn), and Play
 * that steps through the build order. Drawn from the plan data alone — no diagram library.
 */
export default function GoalPage({ goalKey, token, work, api, setSelected, onBack }: {
  goalKey: string;
  token: string;
  work: Work[];
  api: (path: string, data?: unknown) => Promise<any>;
  setSelected: (id: string | null) => void;
  onBack: () => void;
}) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [error, setError] = useState('');
  const [step, setStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let active = true;
    void api(`goals/${encodeURIComponent(goalKey)}`).then((body: Goal) => { if (active) { setGoal(body); setError(''); } })
      .catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [goalKey, token]);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const workByRef = new Map<string, Work>();
  if (goal?.items) for (const released of goal.items) {
    const item = work.find(entry => entry.id === released.id || entry.key === released.key);
    if (item) workByRef.set(released.ref, item);
  }
  const flow = goal?.plan ? planFlowchart(goal.plan.items, workByRef) : null;
  const activeRef = flow && step !== null ? flow.order[step] : null;
  const activeBox = flow?.boxes.find(box => box.ref === activeRef);

  const stopPlay = () => { if (timer.current) clearInterval(timer.current); timer.current = null; setPlaying(false); };
  const play = () => {
    if (!flow?.order.length) return;
    stopPlay();
    setPlaying(true);
    setStep(0);
    let index = 0;
    timer.current = setInterval(() => {
      index += 1;
      if (index >= flow.order.length) { stopPlay(); setStep(flow.order.length - 1); return; }
      setStep(index);
    }, 1200);
  };

  if (error) return <article className="goal-page" aria-label={`Goal ${goalKey}`}><button type="button" className="text-button back" onClick={onBack}>← Back</button><p role="alert">{error}</p></article>;
  if (!goal) return <article className="goal-page" aria-label={`Goal ${goalKey}`}><button type="button" className="text-button back" onClick={onBack}>← Back</button><p role="status">Loading…</p></article>;

  const outcomes = goal.acceptance?.outcomes ?? [];
  return <article className="goal-page" aria-label={goal.key}>
    <button type="button" className="text-button back" autoFocus onClick={onBack}>← Back</button>
    <header className="goal-head"><span className="mono">{goal.key}</span><h1>{goal.statement}</h1></header>
    {goal.plan?.summary ? <section className="panel goal-summary" aria-label="Plan summary"><h2>Summary</h2><p>{goal.plan.summary}</p></section>
      : <p className="muted">No plan summary yet.</p>}
    {outcomes.length > 0 && <section className="panel goal-outcomes" aria-label="Outcomes"><h2>Outcomes</h2>
      <ul className="outcome-cards">{outcomes.map(outcome => <li key={outcome.id}><strong>{outcome.title}</strong><p>{outcome.criteria.join(' · ')}</p></li>)}</ul></section>}
    {flow ? <section className="panel goal-flow" aria-label="Plan flowchart">
      <div className="flow-toolbar">
        <h2>Plan</h2>
        <button type="button" className="play-plan" aria-label="Play plan walkthrough" onClick={play} disabled={playing}>{playing ? 'Playing…' : 'Play'}</button>
      </div>
      {activeBox && <p className="flow-caption" aria-live="polite"><span className="mono">{activeBox.key ?? activeBox.ref}</span> · {activeBox.plain}</p>}
      <svg className="plan-flow" viewBox={`0 0 ${flow.width} ${flow.height}`} width={flow.width} height={flow.height} role="img" aria-label="Plan flowchart">
        <defs><marker id="plan-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="currentColor"/></marker></defs>
        {flow.arrows.map(arrow => <line key={`${arrow.from}-${arrow.to}`} className="plan-arrow" data-from={arrow.from} data-to={arrow.to}
          x1={arrow.x1} y1={arrow.y1} x2={arrow.x2} y2={arrow.y2} markerEnd="url(#plan-arrow)"/>)}
        {flow.boxes.map(box => {
          const lit = activeRef === box.ref;
          return <g key={box.ref} className={`plan-box state-${box.state.toLowerCase()}${lit ? ' lit' : ''}`} data-ref={box.ref} data-state={box.state}
            transform={`translate(${box.x},${box.y})`} role="link" tabIndex={0}
            onClick={() => box.id && setSelected(box.id)} onKeyDown={event => { if ((event.key === 'Enter' || event.key === ' ') && box.id) { event.preventDefault(); setSelected(box.id); } }}>
            <rect width={box.width} height={box.height} rx="8" fill={planStateColor[box.state as PlanState]} opacity={lit || activeRef === null ? 1 : 0.45}/>
            <text x="12" y="28" fill="#fff" fontSize="12" fontFamily="ui-monospace,monospace">{box.key ?? box.ref}</text>
            <text x="12" y="50" fill="#fff" fontSize="13">{box.plain.length > 36 ? `${box.plain.slice(0, 34)}…` : box.plain}</text>
          </g>;
        })}
      </svg>
      <ul className="flow-legend" aria-label="State colours">{(['Todo', 'Doing', 'Checking', 'Done'] as PlanState[]).map(state =>
        <li key={state}><span className="swatch" style={{ background: planStateColor[state] }}/>{state}</li>)}</ul>
    </section> : <p className="muted">This goal has no plan yet.</p>}
  </article>;
}

/** The goal key in `/goals/KEY`, or null when the path is not a goal page. */
export const goalPathKey = (pathname: string) => /^\/goals\/([^/]+)$/.exec(pathname)?.[1] ?? null;
