import type { Work } from '../../src/model';
import { CandidatePr } from '../candidate';
import { formatDuration } from '../duration';
import { groupOf, nextActor, timedGroups, type Group } from '../groups';
import { phaseLabel, phaseOf, plainStatus } from '../plain-status';
import { prSteps, stepHeld } from '../pr-steps';
import type { StepTransition } from '../flow-replay';
import type { ActionlessCard } from '../pages/actionless';
import type { ReleaseView } from '../release';
import StatusAge from './status-age';
import StepsBar from './steps-bar';
import { Explained } from './term';

/** The plain sentence without its leading "Stuck: ": the group already says it is blocked. */
const unprefixed = (sentence: string) => sentence.replace(/^Stuck: /, '').replace(/^./, c => c.toUpperCase());

/**
 * One item as a row of its group (GY-161): key, title, one line saying why it is where it is, the
 * seven pull-request steps while it moves, who acts next as a role, and — only for moving work —
 * how long it has held the step those seven show (`stepHeld`), red past the one configured
 * threshold. On a phone the same element lays out as a card. The pull request is linked once, on the row's second line; the open
 * control and that link are siblings, never nested, so each stays a separate keyboard stop.
 */
export default function WorkCard({ item, all, repository, now, onOpen, group: given, stall, stepMoves, release }: { item: Work; all?: Work[]; repository?: string | null; now: number; onOpen(id: string): void; group?: Group | null; stall?: ActionlessCard; stepMoves?: readonly StepTransition[] | null; release?: ReleaseView }) {
  const group = given ?? groupOf(item, now, undefined, undefined, release) ?? 'shipped';
  const status = plainStatus(item, now);
  const held = stepHeld(item, now, stepMoves, release);
  const timed = timedGroups.has(group);
  const steps = group === 'moving' || group === 'blocked' ? prSteps(item, now, release) : null;
  const actor = nextActor(item, group, now, release, all);
  const pr = item.candidate && <CandidatePr repository={repository} candidate={item.candidate} workKey={item.key}/>;
  const why = group === 'needs-you' ? actor.does
    : stall ? `Nothing is happening: ${stall.missing} — stuck at “${phaseLabel[phaseOf(item, now)]}” for ${formatDuration((now - Date.parse(stall.heldSince)) / 60000)} with nothing to do next`
      // Merged work held at Deploy is blocked by the release, never "Shipped": say what the release lacks.
      : group === 'blocked' ? (steps?.current === 'deploy' ? unprefixed(`${steps.detail}.`) : unprefixed(status.blocking ?? status.sentence))
        : group === 'backlog' || (group === 'up-next' && actor.who === 'Nobody yet') ? actor.does : null;
  const waited = item.humanRequest ? Math.max(0, now - Date.parse(item.humanRequest.at)) : null;
  return <div className={`work-row group-${group} tone-${status.tone}${timed && held.overdue ? ' overdue' : ''}`} data-row={item.key} data-group={group} onClick={() => onOpen(item.id)}>
    <span className="row-key mono">{item.key}</span>
    <span className="row-main">
      <h3><button type="button" className="card-open" data-title aria-label={`${item.title} — open ${item.key}`} onClick={e => { e.stopPropagation(); onOpen(item.id); }}>{item.title}</button></h3>
      <span className="row-sub status-line">{pr && <span className="card-pr" onClick={e => e.stopPropagation()}>{pr}</span>}{pr && why && ' · '}{why && <Explained sentence={why}/>}{!pr && !why && (steps ? 'No pull request yet' : '')}</span>
    </span>
    {steps ? <span className="row-steps"><StepsBar steps={steps}/></span> : <span className="row-steps"/>}
    <span className="row-who" title="Who acts next">{actor.who}</span>
    <span className="row-time">{timed ? <StatusAge held={held}/> : group === 'needs-you' && waited !== null ? <span className="waited">Waiting {formatDuration(waited / 60000)}</span> : null}</span>
    {group === 'needs-you' && <button type="button" className="decide" onClick={e => { e.stopPropagation(); onOpen(item.id); }}>Decide</button>}
  </div>;
}
