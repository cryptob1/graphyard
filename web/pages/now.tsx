import type { Dashboard } from './dashboard';
import { groupWithin, nextActor } from '../../src/model/board';

/** A personal view of the shared board; ownership is independent of worker leases. */
export default function NowPage({ work, status, observedAt, setSelected }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const mine = work.filter(item => item.owner === status.actor.id);
  return <>
    <div className="page-heading"><div><h1>Now</h1><p className="summary">Your items · {mine.length}</p></div></div>
    {mine.length === 0 ? <div className="empty">You have no items yet.</div> : <table aria-label="Your items"><thead><tr><th>Item</th><th>Stage</th><th>Next step</th></tr></thead>
      <tbody>{mine.map(item => { const next = nextActor(item, groupWithin(item, work, now), now, undefined, work); return <tr key={item.id}>
        <td><button type="button" className="text-button" onClick={() => setSelected(item.id)}>{item.key} · {item.title}</button></td>
        <td>{item.stage}</td><td>{next.who}: {next.does}</td>
      </tr>; })}</tbody></table>}
  </>;
}
