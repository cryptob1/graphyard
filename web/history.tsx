import React, { useState } from 'react';

type Event = { seq: number; kind: string; actor: string; created_at: string };
export default function History({ events }: { events: Event[] }) {
  const [limit, setLimit] = useState(20);
  const [groupObservations, setGroupObservations] = useState(true);
  const groups: { newest: Event; oldest: Event; count: number }[] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (groupObservations && event.kind === 'github.observed' && previous?.newest.kind === event.kind && previous.newest.actor === event.actor) {
      previous.oldest = event; previous.count++;
    } else groups.push({ newest: event, oldest: event, count: 1 });
  }
  return <section aria-label="Work history">
    <h3>History</h3>
    <p className="muted">Latest {events.length} events (up to 300). The full audit history is retained in storage.</p>
    <label className="history-option"><input type="checkbox" checked={groupObservations} onChange={e => { setGroupObservations(e.target.checked); setLimit(20); }}/>Group consecutive GitHub observations</label>
    <div className="history-scroll" role="region" aria-label="History entries" tabIndex={0}>
      <div className="timeline">{groups.slice(0, limit).map(({ newest, oldest, count }) => <div key={newest.seq}>
        <span>{new Date(newest.created_at).toLocaleString()}{count > 1 && <> back to {new Date(oldest.created_at).toLocaleString()}</>}</span>
        <strong>{newest.kind}{count > 1 && ` × ${count}`}</strong><small>{newest.actor}</small>
      </div>)}</div>
      {events.length === 0 && <p>No history loaded.</p>}
    </div>
    <p className="muted">Showing {Math.min(limit, groups.length)} of {groups.length} {groupObservations ? 'entries' : 'events'}.</p>
    {groups.length > limit && <button className="text-button" onClick={() => setLimit(n => n + 20)}>Show more history</button>}
    {limit > 20 && <button className="text-button" onClick={() => setLimit(20)}>Show less history</button>}
  </section>;
}
