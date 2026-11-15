import type { Dashboard } from './dashboard';
import { EmptyState, PageHeader } from '../components/page-layout';
import { isClosed } from '../../src/model';
import { groupLabel, groupWithin, nextActor } from '../../src/model/board';

/** A personal view of the shared board; ownership is independent of worker leases. */
export default function NowPage({ work, status, observedAt, setSelected }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const mine = work.filter(item => item.owner === status.actor.id);
  return <>
    <PageHeader title="Now" fact={mine.length ? `${mine.length} ${mine.length === 1 ? 'item is' : 'items are'} yours.` : 'Nothing is yours yet.'}/>
    {mine.length === 0 ? <EmptyState title="You have no items yet.">The master assigns you as owner when it files work for you. Until then, the shared Work board stays available beside this tab.</EmptyState>
      : <table className="sessions-table" aria-label="Your items"><thead><tr><th scope="col">Item</th><th scope="col">Stage</th><th scope="col">Next step</th></tr></thead>
      <tbody>{mine.map(item => {
        const closed = isClosed(item);
        const group = closed ? null : groupWithin(item, work, now) ?? 'shipped';
        const next = group ? nextActor(item, group, now, undefined, work) : { who: 'Nobody', does: `Closed: ${item.closure?.reason ?? 'no further work'}` };
        return <tr key={item.id}>
          <td><button type="button" className="text-button" onClick={() => setSelected(item.id)}>{item.key} · {item.title}</button></td>
          <td data-label="Stage">{group ? groupLabel[group] : 'Closed'}</td><td data-label="Next step">{next.who}: {next.does}</td>
        </tr>;
      })}</tbody></table>}
  </>;
}
