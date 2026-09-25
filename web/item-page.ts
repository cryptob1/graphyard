import { isClosed, type Gate, type Work } from '../src/model';
import { parkedOnHuman } from '../src/model/human-request';
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
 * Who clears a failing ready gate, read from its refusal rather than from the Build step it holds,
 * the same way "Who acts next" reads it (web/groups.ts `nextActor`): a parked human-only decision
 * is yours; a recorded blocker, or an item not yet released from the backlog, is the master
 * agent's; unfinished dependencies are nobody's yet. Anything else leaves the step's own actor.
 */
export function readyOwner(work: Work, gate: Gate): string | undefined {
  if (parkedOnHuman(work)) return 'You';
  if ((work.blocker && gate.reasons.includes(work.blocker)) || gate.reasons.includes('Not released from backlog')) return 'Master agent';
  if (gate.reasons.length && gate.reasons.every(reason => reason.startsWith('Dependency '))) return 'Nobody yet';
  return undefined;
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
  const groups: LeftGroup[] = [{ step: steps.current, label: stepLabel[steps.current], who: (failing?.name === 'ready' ? readyOwner(work, failing) : undefined) ?? steps.who, lines: failing ? plainLines(failing) : [], current: true }];
  for (const gate of unmet) {
    if (gate === failing) continue;
    const step = stepOfGate(gate.name, handedIn);
    if (!step) continue;
    const group = groups.find(entry => entry.step === step);
    if (group) { group.lines = [...new Set([...group.lines, ...plainLines(gate)])]; continue; }
    groups.push({ step, label: stepLabel[step], who: (gate.name === 'ready' ? readyOwner(work, gate) : undefined) ?? waitsOn(step, gate, work, now, release).who, lines: plainLines(gate), current: false });
  }
  const [current, ...later] = groups;
  return [current, ...later.sort((a, b) => stepIds.indexOf(a.step) - stepIds.indexOf(b.step))].filter(group => group.lines.length > 0);
}

/**
 * A ledger event in plain words. The ledger records a command under the command's own name
 * (src/engine.ts `save(db, work, actor, command, …)`: create, ready, claim, submit, …) and the
 * control plane's own facts under dotted kinds (review.requested, merge.execution.committed,
 * delivery.verified, …); both read here as what happened to the item. Internal kinds never reach
 * the reader; an unknown one reads as an update.
 */
export function activityLabel(kind: string): string {
  const exact: Record<string, string> = {
    // Commands (src/engine.ts `commands`), recorded under their own names.
    create: 'Created', ready: 'Released for work', requirements: 'Requirements changed', reviewpolicy: 'Review rules changed', unblock: 'Unblocked',
    rework: 'Sent back for changes', resolve: 'A decision was recorded', recover: 'Recovered after a builder stopped', claim: 'Picked up by a builder',
    rereview: 'Asked for a fresh review', heartbeat: 'The builder is still working', quarantine: 'A stopped builder was fenced off', launch: 'A session was started',
    settle: 'A builder’s attempt ended', autosettle: 'A builder’s attempt ended', release: 'A builder stopped working on it', workspace: 'The builder said where the code lives',
    submit: 'Handed in', blocked: 'The builder reported it blocked', scope: 'The builder asked to change the planned files', autoscope: 'The planned files were changed',
    evidence: 'Proof recorded', deployment: 'Deployment recorded', revoke: 'A proof was withdrawn', session: 'A session was recorded', request: 'An agent asked for a decision',
    repair: 'Asked to repair the branch',
    // The control plane's own facts.
    'human.requested': 'Asked you for a decision', 'human.answered': 'You answered', 'review.requested': 'Review requested', 'review.failover': 'Handed to another reviewer',
    'queue.ejected': 'Taken out of the line to merge', 'queue.predicted': 'Lined up to merge', 'merge.execution.committed': 'Merged', 'delivery.verified': 'Live in production',
    'direct-merge.delivered': 'Merged', 'lease.expired': 'A builder’s time ran out', 'work.closed': 'Closed', 'intake.created': 'Created',
    'base.refreshed': 'Brought up to date with the main branch', 'base.conflict': 'Conflicts with the main branch', 'capacity.exhausted': 'Out of agent capacity',
    'capacity.interrupted': 'Out of agent capacity', 'capacity.restored': 'Agent capacity restored', 'capacity.escalated': 'Asked for more agent capacity',
    'evidence.exercise.refused': 'A proof did not count',
  };
  if (exact[kind]) return exact[kind];
  const prefix: [RegExp, string][] = [
    [/^lease\./, 'A builder stopped working on it'], [/^github\./, 'Graphyard checked GitHub'], [/^review\./, 'Review updated'],
    [/^evidence\./, 'Proof recorded'], [/^queue\./, 'Line to merge updated'], [/^merge\./, 'Merge step recorded'], [/^(branch|base)\./, 'Branch updated'],
    [/^(decision|escalation|closed-question|judgement|lead)\./, 'A decision was recorded'], [/^(requirements|policy)\./, 'Requirements changed'],
    [/^(action|validation)\./, 'Graphyard ran a step'], [/^capacity\./, 'Agent capacity changed'],
  ];
  return prefix.find(([pattern]) => pattern.test(kind))?.[1] ?? 'Updated';
}

/**
 * The rows one `/api/events?work=…` read returns (src/events-history.ts `eventHistoryLimits.page`;
 * a test keeps the two equal). The page reads one page and does not follow the cursor, so a read
 * that fills the page is the latest history, not all of it.
 */
export const historyPage = 300;

/**
 * The Activity section's expand label. The page reads without `routine=include`, so the routine
 * rows (src/events-history.ts `routineEventKinds`: GitHub checks, heartbeats) are never among the
 * rows loaded, and the label never calls the read complete: it says what was left out, and when
 * the read fills the page, that older history was not loaded either.
 */
export function historyLabel(loaded: number): string {
  return loaded < historyPage
    ? `History (${loaded} events; routine GitHub checks and heartbeats left out)`
    : `Latest ${loaded} events — older history and routine GitHub checks and heartbeats are not loaded here`;
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
