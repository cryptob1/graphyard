import { stepIds, stepLabel, type PrSteps, type StepState } from '../pr-steps';

/**
 * The eight pull-request steps as one bar (GY-161, GY-434): done, current (live), pending and
 * skipped segments, with the current step's plain-words label under it. The Work page row, the
 * phone card and the item page all draw this component from `prSteps`, so the three can never
 * disagree. A skipped step — research where no brief will exist — is its own segment, never
 * missing and never failed.
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
      <strong><span className="step-mark" aria-hidden="true">{stepMark[step.state]}</span>{step.label}</strong>
      <span className="step-note">{stepNote(step, steps)}</span>
    </li>)}
  </ol>;
}

const stepMark: Record<StepState, string> = { done: '✓', current: '●', pending: '○', skipped: '–' };
const stepNote = (step: { state: StepState }, steps: PrSteps) =>
  step.state === 'done' ? 'Done' : step.state === 'current' ? steps.label.replace(/^[^·]+· /, '') : step.state === 'skipped' ? 'Skipped' : 'Pending';

/**
 * The eight step names above the Moving rows, laid out as the same track as each row's bar (same
 * element, same gap, one equal share per step) so every name sits over its own segment.
 */
export function StepNames() {
  return <span className="steps-track step-names" aria-hidden="true">{stepIds.map(id => <span key={id} className="step-name" data-step={id}>{stepLabel[id]}</span>)}</span>;
}
