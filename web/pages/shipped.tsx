import { isClosed, isDelivered, type Work } from '../../src/model';
import { CandidatePr } from '../candidate';
import { plainStatus } from '../plain-status';
import { Explained } from '../components/term';
import type { Dashboard } from './dashboard';

/** Every delivered item, newest first, with its pull request and whether the release serves it; closed items apart, below. */
export default function ShippedPage({ work, status, observedAt, setSelected }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const shippedAt = (w: Work) => w.observation?.mergedAt ?? w.stageEnteredAt;
  const closed = work.filter(isClosed).sort((a, b) => b.closure!.at.localeCompare(a.closure!.at));
  const shipped = work.filter(isDelivered).sort((a, b) => shippedAt(b).localeCompare(shippedAt(a)));
  return <>
    <div className="page-heading"><h1>Shipped</h1></div>
    {shipped.length === 0 ? <p className="muted">Nothing has shipped yet. Items appear here once their pull request merges.</p>
      : <ul className="shipped-list shipped-page">{shipped.map(w => { const plain = plainStatus(w, now); return <li key={w.id} className={`tone-${plain.tone}`}>
        <button className="text-button" onClick={() => setSelected(w.id)}>{w.key} <span data-title>{w.title}</span></button>
        {w.candidate && <CandidatePr repository={status?.repository} candidate={w.candidate} workKey={w.key}/>}
        <span className="muted">{new Date(shippedAt(w)).toLocaleDateString()}</span>
        {plain.blocking && <span className={plain.tone === 'stuck' ? 'danger-text' : 'amber'}><Explained sentence={plain.blocking}/></span>}
      </li>; })}</ul>}
    {closed.length > 0 && <details className="work-list closed-history"><summary>Closed without shipping <span className="count">{closed.length}</span></summary>
      <ul className="shipped-list">{closed.map(w => <li key={w.id}>
        <button className="text-button" onClick={() => setSelected(w.id)}>{w.key} <span data-title>{w.title}</span></button>
        <span className="muted">{w.closure!.kind}{w.closure!.ref ? ` · ${w.closure!.ref}` : ''} · {new Date(w.closure!.at).toLocaleDateString()} · {w.closure!.by}</span>
        <span>{w.closure!.reason}</span>
      </li>)}</ul></details>}
  </>;
}
