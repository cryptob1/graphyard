import { isClosed, isDelivered, type Work } from '../../src/model';
import { CandidatePr } from '../candidate';
import { plainStatus } from '../../src/model/plain-status';
import { liveFailingLine, plainStage, serveView } from '../../src/model/plain-stage';
import { releasedAt } from '../groups';
import { releaseView } from '../../src/model/release';
import { Explained } from '../components/term';
import type { Dashboard } from './dashboard';
import { EmptyState, PageHeader, PageSection } from '../components/page-layout';

/**
 * Every delivered item, newest first, with its pull request and the plain stage (GY-2988) —
 * Merged, not live yet / Live / Live and verified / Live and failing / Done; a failing live app is
 * one release-level line, not a verdict on every row; closed items apart, below.
 */
export default function ShippedPage({ work, status, observedAt, setSelected }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const release = releaseView(status);
  const serve = serveView(status);
  const live = (w: Work) => releasedAt(w, release) !== null;
  const shippedAt = (w: Work) => w.observation?.mergedAt ?? w.stageEnteredAt;
  const closed = work.filter(isClosed).sort((a, b) => b.closure!.at.localeCompare(a.closure!.at));
  const shipped = work.filter(isDelivered).sort((a, b) => shippedAt(b).localeCompare(shippedAt(a)));
  return <>
    <PageHeader title="Shipped" fact={shipped.length ? `${shipped.length} shipped · latest ${new Date(shippedAt(shipped[0])).toLocaleDateString()}, ${shipped[0].key} ${shipped[0].title}` : 'Nothing has shipped yet.'}/>
    {liveFailingLine(serve) && <p className="danger-text" data-live-failing>{liveFailingLine(serve)}.</p>}
    {shipped.length === 0 ? <EmptyState title="Shipped items land here.">Each item appears once its pull request merges, with whether it is live.</EmptyState>
      : <PageSection title="Delivered" count={shipped.length} label="Delivered"><ul className="shipped-list shipped-page">{shipped.map(w => { const plain = plainStatus(w, now); const label = plainStage(w, now, release, serve); return <li key={w.id} className={`tone-${plain.tone}`}>
        <button className="text-button" onClick={() => setSelected(w.id)}>{w.key} <span data-title>{w.title}</span></button>
        {w.candidate && <CandidatePr repository={status?.repository} candidate={w.candidate} workKey={w.key} observation={w.observation}/>}
        <span className="muted">{new Date(shippedAt(w)).toLocaleDateString()}</span>
        <span className={live(w) ? undefined : 'muted'} data-live={live(w)} data-plain-stage={label}>{label}</span>
        {plain.blocking && <span className={plain.tone === 'stuck' ? 'danger-text' : 'amber'}><Explained sentence={plain.blocking}/></span>}
      </li>; })}</ul></PageSection>}
    {closed.length > 0 && <details className="panel closed-history"><summary>Closed without shipping <span className="count">{closed.length}</span></summary>
      <ul className="shipped-list">{closed.map(w => <li key={w.id}>
        <button className="text-button" onClick={() => setSelected(w.id)}>{w.key} <span data-title>{w.title}</span></button>
        <span className="muted">{w.closure!.kind}{w.closure!.ref ? ` · ${w.closure!.ref}` : ''} · {new Date(w.closure!.at).toLocaleDateString()} · {w.closure!.by}</span>
        <span>{w.closure!.reason}</span>
      </li>)}</ul></details>}
  </>;
}
