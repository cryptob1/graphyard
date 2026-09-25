import { isClosed, type Gate, type Work } from '../src/model';
import { fileConflicts } from '../src/coordination';
import { plainReason } from './plain-status';
import { prSteps, stepGate, stepIds, stepLabel, waitsOn, type StepId } from './pr-steps';
import { noRelease, type ReleaseView } from './release';

/**
 * The item page below its first screen (GY-171), as plain data the page renders: what is left,
 * grouped by the pull-request step that owns it and naming who clears it; the latest activity in
 * plain words; and planned-file overlaps as one line. Every gate reason reaches the reader through
 * `plainReason`; the raw text stays under Technical details.
 */

export interface LeftGroup {
  step: StepId;
  label: string;
  /** Who clears this step's requirements, as a role (the same roles the step bar names). */
  who: string;
  lines: string[];
  /** The step the bar shows as current; the other groups are later steps. */
  current: boolean;
}

/** The step whose requirement a gate states. The build gate is Build until the work is handed in, then Validate. */
const stepOfGate = (gate: string, handedIn: boolean): StepId | undefined =>
  ({ ready: 'build', build: handedIn ? 'validate' : 'build', test: 'test', review: 'review', acceptance: 'prove', merge: 'merge' } as Record<string, StepId>)[gate];

/** One gate's reasons in plain words, each once: a proof still owed is named by the proof. */
export function plainLines(gate: Gate): string[] {
  return [...new Set(gate.reasons.map(reason => {
    const proof = reason.match(/^AC-\d+: (\S+) needs trusted/)?.[1];
    return proof ? `The proof ${proof} has not passed yet` : plainReason(reason, gate.name).text;
  }))];
}

/**
 * Every unmet requirement, one plain line each, grouped by step. The current step comes first —
 * its lines are the refusal of that step's own gate (Test before Review, unlike the evaluation
 * order), or, before the hand-in, whatever holds the build — then every later step in the order a
 * pull request travels. Merged work held at Deploy is left with what the release lacks; work closed
 * without merging has nothing left.
 */
export function whatIsLeft(work: Work, now: number, release: ReleaseView = noRelease): LeftGroup[] {
  if (isClosed(work)) return [];
  const steps = prSteps(work, now, release);
  if (!steps.current) return [];
  if (steps.current === 'deploy') return [{ step: 'deploy', label: stepLabel.deploy, who: steps.who, lines: [`${steps.detail.replace(/^./, c => c.toUpperCase())}.`], current: true }];
  const unmet = work.gates.filter(gate => !gate.passed);
  const own = steps.current !== 'build' ? work.gates.find(gate => gate.name === stepGate[steps.current!] && !gate.passed) : undefined;
  const failing = own ?? unmet[0];
  const handedIn = steps.current !== 'build';
  const groups: LeftGroup[] = [{ step: steps.current, label: stepLabel[steps.current], who: steps.who, lines: failing ? plainLines(failing) : [], current: true }];
  for (const gate of unmet) {
    if (gate === failing) continue;
    const step = stepOfGate(gate.name, handedIn);
    if (!step) continue;
    const group = groups.find(entry => entry.step === step);
    if (group) { group.lines = [...new Set([...group.lines, ...plainLines(gate)])]; continue; }
    groups.push({ step, label: stepLabel[step], who: waitsOn(step, gate, work, now, release).who, lines: plainLines(gate), current: false });
  }
  const [current, ...later] = groups;
  return [current, ...later.sort((a, b) => stepIds.indexOf(a.step) - stepIds.indexOf(b.step))].filter(group => group.lines.length > 0);
}

/** A ledger event in plain words. Internal kinds never reach the reader; an unknown one reads as an update. */
export function activityLabel(kind: string): string {
  const exact: Record<string, string> = {
    'work.created': 'Created', 'work.ready': 'Released for work', 'work.released': 'Released for work', 'work.claimed': 'Picked up by a builder',
    'lease.claimed': 'Picked up by a builder', 'work.submitted': 'Handed in', 'work.closed': 'Closed', 'human.requested': 'Asked you for a decision',
    'review.requested': 'Review requested', 'review.submitted': 'Reviewed', 'review.completed': 'Reviewed', 'merge.commit': 'Merged',
    'work.delivery.deployment': 'Deployed', 'queue.ejected': 'Taken out of the line to merge',
  };
  if (exact[kind]) return exact[kind];
  const prefix: [RegExp, string][] = [
    [/^lease\./, 'A builder stopped working on it'], [/^github\./, 'Graphyard checked GitHub'], [/^review\./, 'Review updated'],
    [/^evidence\./, 'Proof recorded'], [/^queue\./, 'Line to merge updated'], [/^merge\./, 'Merge step recorded'],
    [/^decision\./, 'A decision was recorded'], [/^(requirements|policy)\./, 'Requirements changed'],
  ];
  return prefix.find(([pattern]) => pattern.test(kind))?.[1] ?? 'Updated';
}

/**
 * Planned-file overlaps as one line: every overlapping item and the paths this item shares with
 * them — "Shares files with GY-166, GY-167 (tests/)" — never one box per item.
 */
export function overlapLine(work: Work, all: Work[]): string | null {
  const conflicts = fileConflicts(work, all);
  if (!conflicts.length) return null;
  const paths = [...new Set(conflicts.flatMap(conflict => conflict.paths))];
  return `Shares files with ${conflicts.map(conflict => conflict.key).join(', ')} (${paths.join(', ')})`;
}
