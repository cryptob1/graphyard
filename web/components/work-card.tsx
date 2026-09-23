import type { Work } from '../../src/model';
import { CandidatePr } from '../candidate';
import { plainStatus, statusHeld } from '../plain-status';
import StatusAge from './status-age';
import { Explained } from './term';

/**
 * One item: its key, how long it has held its current status, its title, and the plain status
 * sentence. The duration is always drawn, on every card in every view, and turns red past the
 * one configured threshold; the card is outlined in the same red, so a stalled item is legible
 * from the shape of the list. The selection control and the pull request link are siblings,
 * never nested, so each stays a separate keyboard stop.
 */
export default function WorkCard({ item, repository, now, onOpen }: { item: Work; repository?: string | null; now: number; onOpen(id: string): void }) {
  const status = plainStatus(item, now);
  const held = statusHeld(item, now);
  return <div className={`card tone-${status.tone}${held.overdue ? ' overdue' : ''}`} onClick={() => onOpen(item.id)}>
    <div className="card-top"><span>{item.key}</span><StatusAge held={held}/></div>
    <h3><button className="card-open" data-title aria-label={`${item.title} — open ${item.key} details`} onClick={e => { e.stopPropagation(); onOpen(item.id); }}>{item.title}</button></h3>
    <div className="card-meta"><p className="status-line"><Explained sentence={status.sentence}/></p>{item.candidate && <span className="push card-pr"><CandidatePr repository={repository} candidate={item.candidate} workKey={item.key}/></span>}</div>
  </div>;
}
