import type { Dashboard } from './dashboard';
import { isClosed } from '../../src/model';
import { groupLabel, groupWithin, nextActor } from '../../src/model/board';

/** A personal view of the shared board; ownership is independent of worker leases. */
export default function NowPage({ work, status, observedAt, setSelected }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const mine = work.filter(item => item.owner === status.actor.id);
  return <>
    <div className="page-heading"><div><h1>Now</h1><p className="summary">Your items · {mine.length}</p></div></div>
    {mine.length === 0 ? <div className="empty">
      <p>You have no items yet.</p>
      <p className="muted">The master assigns you as owner when it files work for you. Until then, the shared Work board stays available beside this tab.</p>
    </div> : <table aria-label="Your items"><thead><tr><th>Item</th><th>Stage</th><th>Next step</th></tr></thead>
      <tbody>{mine.map(item => {
        const closed = isClosed(item);
        const group = closed ? null : groupWithin(item, work, now) ?? 'shipped';
        const next = group ? nextActor(item, group, now, undefined, work) : { who: 'Nobody', does: `Closed: ${item.closure?.reason ?? 'no further work'}` };
        return <tr key={item.id}>
          <td><button type="button" className="text-button" onClick={() => setSelected(item.id)}>{item.key} · {item.title}</button></td>
          <td>{group ? groupLabel[group] : 'Closed'}</td><td>{next.who}: {next.does}</td>
        </tr>;
      })}</tbody></table>}
  </>;
}
