import { isClosed, isDelivered, type Work } from '../../src/model';
import { CandidatePr } from '../candidate';
import { plainStatus } from '../../src/model/plain-status';
import { liveFailingLine, plainStage, serveView } from '../../src/model/plain-stage';
import { releasedAt } from '../groups';
import { releaseView } from '../../src/model/release';
import { trustCounts, type TrustKind } from '../trust';
import Term, { Explained } from '../components/term';
import type { ReactNode } from 'react';
import type { Dashboard } from './dashboard';
import { EmptyState, PageHeader, PageSection } from '../components/page-layout';

/** What one trust filter shows, in the words the header's strip numbers it by. */
const trustLabel: Record<TrustKind, string> = {
  'verified-by-running': 'delivered items verified by running',
  'sent-back': 'delivered items sent back',
  reverts: 'items the batch gate reverted',
};

/**
 * The trust strip (GY-3395), on the Shipped page since the header shows only what is happening
 * now (GY-3483): three numbers for the last seven days — the share of
 * delivered items whose proofs ran the real app, the share sent back for rework, and the items the
 * batch gate reverted — read off the same snapshot the page below shows (web/trust.ts), each number
 * filtering the list below to the items behind it. The numbers carry data attributes with
 * exactly what the sentence says, so a reader (and a test) checks the words against the records
 * the item pages read, in the app's own words: verified by running, sent back, reverted — the
 * last with the glossary's "reverts this week" on hover, which names the seven-day window.
 */
export function TrustStrip({ work, observedAt, onItems }: { work: Work[]; observedAt: number; onItems: (kind: TrustKind) => void }) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const { delivered, verifiedByRunning, sentBack, reverts } = trustCounts(work, now);
  const number = (kind: TrustKind, items: readonly Work[], label: ReactNode, share = false) => <button type="button" className="text-button" data-trust={kind} onClick={() => onItems(kind)}>
    <span className="mono">{items.length}{share ? `/${delivered.length}` : ''}</span> {label}
  </button>;
  return <p className="trust-strip" aria-label="Trust" data-verified-by-running={verifiedByRunning.length} data-delivered={delivered.length} data-sent-back={sentBack.length} data-reverts={reverts.length}>
    {number('verified-by-running', verifiedByRunning, 'verified by running', true)}
    <span aria-hidden="true"> · </span>{number('sent-back', sentBack, 'sent back', true)}
    <span aria-hidden="true"> · </span>{number('reverts', reverts, <Term term="reverts this week" focusable={false}>reverted</Term>)}
  </p>;
}

/**
 * Every delivered item, newest first, with its pull request and the plain stage (GY-2988) —
 * Merged, not live yet / Live / Live and verified / Live and failing / Done; a failing live app is
 * one release-level line, not a verdict on every row; closed items apart, below. A trust number
 * on the strip above (GY-3395) opens this page showing exactly the items behind it, from the last
 * seven days, with the note saying so.
 */
export default function ShippedPage({ work, status, observedAt, setSelected, shippedFilter, setShippedFilter }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const release = releaseView(status);
  const serve = serveView(status);
  const live = (w: Work) => releasedAt(w, release) !== null;
  const shippedAt = (w: Work) => w.observation?.mergedAt ?? w.stageEnteredAt;
  const closed = work.filter(isClosed).sort((a, b) => b.closure!.at.localeCompare(a.closure!.at));
  const shipped = work.filter(isDelivered).sort((a, b) => shippedAt(b).localeCompare(shippedAt(a)));
  const counts = trustCounts(work, now);
  const behind: Record<TrustKind, Work[]> = { 'verified-by-running': counts.verifiedByRunning, 'sent-back': counts.sentBack, reverts: counts.reverts };
  const shown = shippedFilter
    ? behind[shippedFilter].slice().sort((a, b) => shippedAt(b).localeCompare(shippedAt(a)))
    : shipped;
  return <>
    <PageHeader title="Shipped" fact={shipped.length ? `${shipped.length} shipped · latest ${new Date(shippedAt(shipped[0])).toLocaleDateString()}, ${shipped[0].key} ${shipped[0].title}` : 'Nothing has shipped yet.'}/>
    <TrustStrip work={work} observedAt={observedAt} onItems={setShippedFilter}/>
    {liveFailingLine(serve) && <p className="danger-text" data-live-failing>{liveFailingLine(serve)}.</p>}
    {shippedFilter && <p className="filter-note" data-trust-note={shippedFilter}>Showing {shown.length}{shippedFilter === 'reverts' ? ' reverted this week' : ` of ${counts.delivered.length} delivered this week`}: {trustLabel[shippedFilter]} · <button type="button" className="text-button" onClick={() => setShippedFilter(null)}>Show every delivered item</button></p>}
    {shown.length === 0 ? <EmptyState title={shippedFilter ? `No ${trustLabel[shippedFilter]} in the last 7 days.` : 'Shipped items land here.'}>{shippedFilter ? undefined : 'Each item appears once its pull request merges, with whether it is live.'}</EmptyState>
      : <PageSection title="Delivered" count={shown.length} label="Delivered"><ul className="shipped-list shipped-page">{shown.map(w => { const plain = plainStatus(w, now); const label = plainStage(w, now, release, serve); return <li key={w.id} className={`tone-${plain.tone}`}>
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
