import type { PrSteps } from '../pr-steps';

/**
 * The seven pull-request steps as one bar (GY-161): done, current (live) and pending segments,
 * with the current step's plain-words label under it. The Work page row, the phone card and the
 * item page all draw this component from `prSteps`, so the three can never disagree.
 */
export default function StepsBar({ steps, labelled = true }: { steps: PrSteps; labelled?: boolean }) {
  const at = steps.current ? steps.steps.findIndex(step => step.id === steps.current) + 1 : steps.steps.length;
  return <span className="steps-bar" data-current={steps.current ?? 'live'}>
    <span className="steps-track" role="img" aria-label={`Step ${at} of ${steps.steps.length}: ${steps.label}`}>
      {steps.steps.map(step => <span key={step.id} className={`step-seg ${step.state}`} data-step={step.id} data-state={step.state} title={step.label}/>)}
    </span>
    {labelled && <span className="steps-label">{steps.label}</span>}
  </span>;
}

/** The item page's version: each step named under its segment, the current one live. */
export function StepsDetail({ steps }: { steps: PrSteps }) {
  return <ol className="steps-detail" aria-label="Pull request steps">
    {steps.steps.map(step => <li key={step.id} className={`step-seg-detail ${step.state}`} data-step={step.id} data-state={step.state}>
      <span className={`step-seg ${step.state}`}/>
      <strong><span className="step-mark" aria-hidden="true">{step.state === 'done' ? '✓' : step.state === 'current' ? '●' : '○'}</span>{step.label}</strong>
      <span className="step-note">{step.state === 'done' ? 'Done' : step.state === 'current' ? steps.label.replace(/^[^·]+· /, '') : 'Pending'}</span>
    </li>)}
  </ol>;
}
