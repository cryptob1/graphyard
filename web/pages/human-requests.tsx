import { useState } from 'react';
import { humanDecisionLabel, openHumanRequests, type HumanRequestRow } from '../../src/model/human-request';
import { formatDuration } from '../duration';
import type { Dashboard } from './dashboard';

/**
 * What waits on the human, and nothing else: each open decision only a human may make — goals
 * and priorities, money or a third-party account, a credential for a person — with the exact
 * thing needed, why, who asked and how long it has waited. Answering it here is the whole
 * resumption: the item returns to the loop, which dispatches it again without a master session.
 * Recently answered requests stay listed so the human can see what their answer set in motion.
 */
export default function HumanRequestsPage({ work, status, observedAt, action, busy, setSelected }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const requests = openHumanRequests(work, now);
  const answered = work.flatMap(item => (item.humanRequests ?? []).filter(request => request.answer).map(request => ({ item, request })))
    .sort((a, b) => b.request.answer!.at.localeCompare(a.request.answer!.at)).slice(0, 10);
  // Only a declared human session may answer: the server refuses anything else, so the form is not offered.
  const canAnswer = status?.actor?.role === 'admin' && status?.actor?.sessionKind === 'human';
  return <>
    <div className="page-heading"><h1>Needs you <span className="count" title="Open requests only a human may answer">{requests.length}</span></h1></div>
    <p className="muted">Agents decide everything except goals and priorities, spending money or opening third-party accounts, and issuing credentials to people. An item that reaches one of those parks here without holding a worker; everything else keeps moving.</p>
    {requests.length === 0 ? <p className="muted">Nothing is waiting on you.</p>
      : <div className="cards">{requests.map(row => <RequestCard key={row.request.id} row={row} canAnswer={canAnswer} busy={busy} open={() => setSelected(row.id)}
        answer={(text, outcome) => action(row.id, 'answer', { request: row.request.id, outcome, answer: text })}/>)}</div>}
    {!canAnswer && requests.length > 0 && <p className="muted">Sign in with the operator's own (human) credential to answer, or run the command shown on the request.</p>}
    {answered.length > 0 && <section className="work-list" aria-label="Recently answered"><h2>Recently answered</h2><ul className="shipped-list">{answered.map(({ item, request }) => <li key={request.id}>
      <button className="text-button" onClick={() => setSelected(item.id)}>{item.key} <span data-title>{item.title}</span></button>
      <span className="muted">{humanDecisionLabel[request.kind]} · {request.answer!.outcome} by {request.answer!.by} after {formatDuration(request.answer!.waitedMs / 60000)}</span>
      <span>{request.answer!.text}</span>
    </li>)}</ul></section>}
  </>;
}

function RequestCard({ row, canAnswer, busy, open, answer }: { row: HumanRequestRow; canAnswer: boolean; busy: boolean; open(): void; answer(text: string, outcome: 'provided' | 'declined'): Promise<void> }) {
  const [text, setText] = useState('');
  const send = (outcome: 'provided' | 'declined') => { if (text.trim()) void answer(text.trim(), outcome).then(() => setText('')); };
  return <div className="card human-request">
    <div className="card-top"><button className="text-button" onClick={open}>{row.work} <span data-title>{row.title}</span></button><span title={`Asked ${row.request.at}`}>Waiting {formatDuration(row.waitedMs / 60000)}</span></div>
    <h3>{row.request.needed}</h3>
    <p className="reason">{row.decision} · asked by {row.request.requestedBy}: {row.request.reason}</p>
    {canAnswer ? <form onSubmit={event => { event.preventDefault(); send('provided'); }}>
      <textarea aria-label={`Answer for ${row.work}`} placeholder="What you decided or provided, in words the next worker can act on…" value={text} onChange={event => setText(event.target.value)} rows={3}/>
      <div className="list-tools"><button type="submit" disabled={busy || !text.trim()}>Answer and resume {row.work}</button><button type="button" className="text-button" disabled={busy || !text.trim()} onClick={() => send('declined')}>Decline</button></div>
    </form> : null}
    <p className="muted">From a terminal: <code>{row.answer.cli}</code></p>
  </div>;
}
