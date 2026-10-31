import type { Work } from '../../src/model';
import { CandidatePr } from '../candidate';
import { formatDuration } from '../../src/model/duration';
import { groupOf, nextActor, timedGroups, type Group } from '../groups';
import { blockerSummary, phaseLabel, phaseOf, plainStatus } from '../../src/model/plain-status';
import { currentMergeStep } from '../../src/model/merge-ledger';
import { prSteps, stepHeld } from '../../src/model/pr-steps';
import type { ActionlessCard } from '../../src/model/actionless';
import type { ReleaseView } from '../../src/model/release';
import StatusAge from './status-age';
import StepsBar from './steps-bar';
import { Explained } from './term';

/** The plain sentence without its leading "Stuck: ": the group already says it is blocked. */
const unprefixed = (sentence: string) => sentence.replace(/^Stuck: /, '').replace(/^./, c => c.toUpperCase());

/**
 * One item as a row of its group (GY-161): key, title, one line saying why it is where it is, the
 * four states (GY-1979) while it moves, who acts next as a role, and — only for moving work —
 * how long it has held the state the bar shows (`stepHeld`), red past the one configured
 * threshold. On a phone the same element lays out as a card. The candidate is linked once, on the row's second line; the open
 * control and that link are siblings, never nested, so each stays a separate keyboard stop.
 */
export default function WorkCard({ item, all, repository, now, onOpen, group: given, stall, release }: { item: Work; all?: Work[]; repository?: string | null; now: number; onOpen(id: string): void; group?: Group | null; stall?: ActionlessCard; release?: ReleaseView }) {
  const group = given ?? groupOf(item, now, undefined, undefined, release) ?? 'shipped';
  const status = plainStatus(item, now);
  const held = stepHeld(item, now, null, release);
  const timed = timedGroups.has(group);
  const steps = group === 'moving' || group === 'blocked' ? prSteps(item, now, release) : null;
  const actor = nextActor(item, group, now, release, all);
  // The merge writer opens no pull request, so a candidate the control plane observed itself names no PR (GY-2963).
  const pr = item.candidate && item.observation?.source !== 'control-plane' && <CandidatePr repository={repository} candidate={item.candidate} workKey={item.key}/>;
  // GY-2963: a merge whose trial is advancing names where it is, never a stall.
  const mergeStep = currentMergeStep(item, now);
  const merging = mergeStep?.fresh ? `Merging: ${mergeStep.step}, ${formatDuration((now - mergeStep.atMs) / 60000)}` : null;
  // A blocker waiting for a future instant is no stall: its wait is the row's one sentence (GY-1739).
  const waits = group === 'blocked' && item.blocker ? blockerSummary(item.blocker, now, item) : null;
  const why = group === 'needs-you' ? actor.does
    : waits?.kind === 'waiting-until' ? waits.sentence
    : stall ? `Nothing is happening: ${stall.missing} — stuck at “${phaseLabel[phaseOf(item, now)]}” for ${formatDuration((now - Date.parse(stall.heldSince)) / 60000)} with nothing to do next`
      : merging ? merging
      : group === 'blocked' ? unprefixed(status.blocking ?? status.sentence)
        : group === 'backlog' || (group === 'up-next' && actor.who === 'Nobody yet') ? actor.does : null;
  const waited = item.humanRequest ? Math.max(0, now - Date.parse(item.humanRequest.at)) : null;
  return <div className={`work-row group-${group} tone-${status.tone}${timed && held.overdue ? ' overdue' : ''}`} data-row={item.key} data-group={group} onClick={() => onOpen(item.id)}>
    <span className="row-key mono">{item.key}</span>
    <span className="row-main">
      <h3><button type="button" className="card-open" data-title aria-label={`${item.title} — open ${item.key}`} onClick={e => { e.stopPropagation(); onOpen(item.id); }}>{item.title}</button></h3>
      <span className="row-owner">Owner · {item.owner ?? 'Nobody yet'}</span>
      <span className="row-sub status-line">{pr && <span className="card-pr" onClick={e => e.stopPropagation()}>{pr}</span>}{pr && why && ' · '}{why && <Explained sentence={why}/>}{!pr && !why && (steps ? 'No commit recorded yet' : '')}</span>
    </span>
    {steps ? <span className="row-steps"><StepsBar steps={steps} labelled={group !== 'blocked'}/></span> : <span className="row-steps"/>}
    <span className="row-who" title="Who acts next">{actor.who}</span>
    <span className="row-time">{timed ? <StatusAge held={held}/> : group === 'needs-you' && waited !== null ? <span className="waited">Waiting {formatDuration(waited / 60000)}</span> : null}</span>
    {group === 'needs-you' && <button type="button" className="decide" onClick={e => { e.stopPropagation(); onOpen(item.id); }}>Decide</button>}
  </div>;
}
