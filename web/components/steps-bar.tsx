import { stateIds, stateLabel, type PrSteps } from '../../src/model/pr-steps';

/**
 * The four item states as one bar (GY-1979): Todo, Doing, Checking, Done — done, current (live)
 * and pending segments, with the current state's plain-words label under it. The Work page row,
 * the phone card and the item page all draw this component from `prSteps`, so the three can never
 * disagree. Done means merged; the deployment is the board's one release line, not a state here.
 */
export default function StepsBar({ steps, labelled = true }: { steps: PrSteps; labelled?: boolean }) {
  const at = steps.current ? steps.steps.findIndex(step => step.id === steps.current) + 1 : steps.steps.length;
  return <span className="steps-bar" data-current={steps.current ?? 'none'}>
    <span className="steps-track" role="img" aria-label={`State ${at} of ${steps.steps.length}: ${steps.label}`}>
      {steps.steps.map(step => <span key={step.id} className={`step-seg ${step.state}`} data-step={step.id} data-state={step.state} title={step.label}/>)}
    </span>
    {labelled && <span className="steps-label">{steps.label}</span>}
  </span>;
}

/** The item page's version: each state named under its segment, the current one live. The four
 * states lay out as four equal columns (the shared stylesheet's seven-column grid was the old
 * step list's; the states are four, so the track carries its own count). */
export function StepsDetail({ steps }: { steps: PrSteps }) {
  return <ol className="steps-detail" style={{ gridTemplateColumns: `repeat(${steps.steps.length}, minmax(0, 1fr))` }} aria-label="Item states">
    {steps.steps.map(step => <li key={step.id} className={`step-seg-detail ${step.state}`} data-step={step.id} data-state={step.state}>
      <span className={`step-seg ${step.state}`}/>
      <strong><span className="step-mark" aria-hidden="true">{step.state === 'done' ? '✓' : step.state === 'current' ? '●' : '○'}</span>{step.label}</strong>
      <span className="step-note">{step.state === 'done' ? 'Done' : step.state === 'current' ? steps.label.replace(/^[^·]+· /, '') : 'Pending'}</span>
    </li>)}
  </ol>;
}

/**
 * The four state names above the Moving rows, laid out as the same track as each row's bar (same
 * element, same gap, one equal share per state) so every name sits over its own segment.
 */
export function StepNames() {
  return <span className="steps-track step-names" aria-hidden="true">{stateIds.map(id => <span key={id} className="step-name" data-step={id}>{stateLabel[id]}</span>)}</span>;
}
