import { isClosed, type Gate, type Work } from '../src/model';
import { humanRequestBlocker, parkedOnHuman } from '../src/model/human-request';
import { fileConflicts } from '../src/coordination';
import { plainReason } from '../src/model/plain-status';
import { prSteps, stateIds, stateLabel, stepGate, waitsOn, type StateId } from '../src/model/pr-steps';
import { noRelease, type ReleaseView } from '../src/model/release';

/**
 * The item page below its first screen (GY-171), as plain data the page renders: what is left,
 * grouped by the item state that owns it (GY-1979: Todo, Doing, Checking — Done has nothing left)
 * and naming who clears it; the latest activity in plain words; and planned-file overlaps as one
 * line. Every gate reason reaches the reader through `plainReason`; the raw text stays under
 * Technical details.
 */

export interface LeftGroup {
  state: StateId;
  label: string;
  /** Who clears this state's requirements, as a role (the same roles the state bar names). */
  who: string;
  lines: string[];
  /** The state the bar shows as current; the other groups are later states. */
  current: boolean;
}

/** The recorded step whose refusal a gate's lines answer, for the who-clears-it reading. */
const stepOfGate = (gate: string, handedIn: boolean): keyof typeof stepGate | 'build' | undefined =>
  ({ ready: handedIn ? 'validate' : 'build', build: handedIn ? 'validate' : 'build', test: 'test', review: 'review', acceptance: 'prove', merge: 'merge' } as Record<string, keyof typeof stepGate | 'build'>)[gate];

/**
 * One gate's reasons in plain words, each once: a proof still owed is named by the proof. A parked
 * request's blocker carries the whole agent detail; its card states the ask, so the line here only
 * points at it (GY-1408). Given the item, a recorded blocker reads as the same summary its status
 * sentence gives, so both name one clearer (GY-1739).
 */
export function plainLines(gate: Gate, work?: Work, now = Date.now()): string[] {
  return [...new Set(gate.reasons.map(reason => {
    if (reason.startsWith(humanRequestBlocker)) return 'Waiting on your answer to the request on this page';
    const proof = reason.match(/^AC-\d+: (\S+) needs trusted/)?.[1];
    return proof ? `The proof ${proof} has not passed yet` : plainReason(reason, gate.name, now, work).text;
  }))];
}

/**
 * Who clears a failing ready gate, read from its refusal rather than from the Build step it holds,
 * the same way "Who acts next" reads it (web/groups.ts `nextActor`): a parked human-only decision
 * is yours; a recorded blocker, or an item not yet released from the backlog, is the master
 * agent's; unfinished dependencies and undelivered split children are nobody's yet. Anything else leaves the step's own actor.
 */
export function readyOwner(work: Work, gate: Gate): string | undefined {
  if (parkedOnHuman(work)) return 'You';
  if ((work.blocker && gate.reasons.includes(work.blocker)) || gate.reasons.includes('Not released from backlog')) return 'Master agent';
  if (gate.reasons.length && gate.reasons.every(reason => /^(?:Dependency |Split into child items: )/.test(reason))) return 'Nobody yet';
  return undefined;
}

/**
 * Every unmet requirement, one plain line each, grouped by state. The current state comes first —
 * its lines are the refusals that hold it there (all of Checking's folded gates at once: the test,
 * review, proof and merge requirements, with the build gate's while it is not observed yet) — then
 * every later state in the order the states travel. Merged work is Done and has nothing left; work
 * closed without merging has nothing left.
 */
export function whatIsLeft(work: Work, now: number, release: ReleaseView = noRelease): LeftGroup[] {
  if (isClosed(work)) return [];
  const steps = prSteps(work, now, release);
  if (!steps.current || steps.current === 'done') return [];
  const handedIn = steps.current === 'checking';
  const unmet = work.gates.filter(gate => !gate.passed);
  const stateOf = (gate: Gate): StateId => gate.name === 'ready' && !handedIn ? 'todo' : 'checking';
  const groups: LeftGroup[] = [];
  for (const gate of unmet) {
    const state = stateOf(gate);
    let group = groups.find(entry => entry.state === state);
    if (!group) {
      // The current state's who is the bar's own reading (the folded gates in travel order); the
      // ready gate's refusal names its own clearer, and a later state's, its step's actor.
      const who = state === 'todo' ? (readyOwner(work, gate) ?? waitsOn('build', undefined, work, now, release).who)
        : state === steps.current ? steps.who
          : waitsOn(stepOfGate(gate.name, handedIn) ?? 'merge', gate.name === 'ready' ? undefined : gate, work, now, release).who;
      group = { state, label: stateLabel[state], who, lines: [], current: state === steps.current };
      groups.push(group);
    }
    group.lines = [...new Set([...group.lines, ...plainLines(gate, work, now)])];
  }
  // The current state first, then the later ones in the order the states travel.
  return groups.sort((a, b) => (a.current ? -1 : b.current ? 1 : stateIds.indexOf(a.state) - stateIds.indexOf(b.state)));
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
    rereview: 'Asked for a fresh review', mechanicalplan: 'A planned fix round was recorded for the review', heartbeat: 'The builder is still working', quarantine: 'A stopped builder was fenced off', launch: 'A session was started',
    settle: 'A builder’s attempt ended', autosettle: 'A builder’s attempt ended', release: 'A builder stopped working on it', workspace: 'The builder said where the code lives',
    submit: 'Handed in', blocked: 'The builder reported it blocked', defer: 'The builder found its reading cannot exist yet and set it to wait', window: 'Set to wait until its reading can exist', dispatchblock: 'Graphyard stopped starting it after the same launch failure repeated', scope: 'The builder asked to change the planned files', autoscope: 'The planned files were changed',
    evidence: 'Proof recorded', deployment: 'Deployment recorded', reading: 'The loop recorded its reading', revoke: 'A proof was withdrawn', session: 'A session was recorded', request: 'An agent asked for a decision',
    repair: 'Asked to repair the branch', mergerefused: 'The merge kept being refused, so a fresh review or rework was asked for',
    refresh: 'Asked to merge the repaired base in', adopt: 'An existing pull request was adopted into it',
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
