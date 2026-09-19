import type { Work } from '../../src/model';
import { CandidatePr } from '../candidate';
import { age } from '../format';
import { plainStatus } from '../plain-status';

/**
 * One item: its key, title, and the plain status sentence. The selection control and the pull
 * request link are siblings, never nested, so each stays a separate keyboard stop.
 */
export default function WorkCard({ item, repository, now, onOpen }: { item: Work; repository?: string | null; now: number; onOpen(id: string): void }) {
  const status = plainStatus(item, now);
  return <div className={`card tone-${status.tone}`} onClick={() => onOpen(item.id)}>
    <div className="card-top"><span>{item.key}</span></div>
    <h3><button className="card-open" data-title aria-label={`${item.title} — open ${item.key} details`} onClick={e => { e.stopPropagation(); onOpen(item.id); }}>{item.title}</button></h3>
    <div className="card-meta"><p className="status-line" title={`In this step for ${age(item.stageEnteredAt)}`}>{status.sentence}</p>{item.candidate && <span className="push card-pr"><CandidatePr repository={repository} candidate={item.candidate} workKey={item.key}/></span>}</div>
  </div>;
}
