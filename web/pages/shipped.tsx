import type { Work } from '../../src/model';
import { CandidatePr } from '../candidate';
import { plainStatus } from '../plain-status';
import type { Dashboard } from './dashboard';

/** Every delivered item, newest first, with its pull request and whether the release serves it. */
export default function ShippedPage({ work, status, observedAt, setSelected }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const shippedAt = (w: Work) => w.observation?.mergedAt ?? w.stageEnteredAt;
  const shipped = work.filter(w => w.stage === 'done').sort((a, b) => shippedAt(b).localeCompare(shippedAt(a)));
  return <>
    <div className="page-heading"><h1>Shipped</h1></div>
    {shipped.length === 0 ? <p className="muted">Nothing has shipped yet. Items appear here once their pull request merges.</p>
      : <ul className="shipped-list shipped-page">{shipped.map(w => { const plain = plainStatus(w, now); return <li key={w.id} className={`tone-${plain.tone}`}>
        <button className="text-button" onClick={() => setSelected(w.id)}>{w.key} <span data-title>{w.title}</span></button>
        {w.candidate && <CandidatePr repository={status?.repository} candidate={w.candidate} workKey={w.key}/>}
        <span className="muted">{new Date(shippedAt(w)).toLocaleDateString()}</span>
        {plain.blocking && <span className={plain.tone === 'stuck' ? 'danger-text' : 'amber'}>{plain.blocking}</span>}
      </li>; })}</ul>}
  </>;
}
