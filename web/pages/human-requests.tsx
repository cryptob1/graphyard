import { useState } from 'react';
import { humanDecisionLabel, humanOnlyRefusal, openHumanOnly, type HumanOnlyPost, type HumanRequestRow } from '../../src/model/human-request';
import { formatDuration } from '../duration';
import type { Dashboard } from './dashboard';

/**
 * What waits on the human, and nothing else: every action the server will take from the
 * operator's own credential alone — a decision only a human may make (goals and priorities,
 * money or a third-party account, a credential for a person), and an approval no agent identity
 * can give — with the exact thing needed, why, who asked and how long it has waited.
 *
 * The page renders the human-only rule table (src/model/human-request.ts) and holds no list of
 * kinds itself: each row says which rule raised it, how the operator answers it, and what an
 * agent identity is told instead, so a rule added to that table is listed here without a change
 * to this file (GY-102). Answering is the whole resumption, in this authenticated session: no
 * credential is ever handled on a command line. Recently answered requests stay listed so the
 * human can see what their answer set in motion.
 */
export default function HumanRequestsPage({ work, status, observedAt, action, busy, setSelected }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  // The rows the server derived from the rule table. A client whose status read has not landed
  // yet still sees every rule whose instances live on the work documents it already holds,
  // derived here from that same table.
  const requests: HumanRequestRow[] = status?.humanOnly ?? openHumanOnly(work.map(item => ({ work: item })), now);
  const answered = work.flatMap(item => (item.humanRequests ?? []).filter(request => request.answer).map(request => ({ item, request })))
    .sort((a, b) => b.request.answer!.at.localeCompare(a.request.answer!.at)).slice(0, 10);
  // Only the operator's own session may answer: the server refuses anything else with the very
  // words the rule carries, so a session it refuses is shown the refusal instead of the form.
  const refusalFor = (row: HumanRequestRow) => humanOnlyRefusal(row.rule, status?.actor ?? {});
  const refused = requests.map(refusalFor).find(refusal => refusal);
  return <>
    <div className="page-heading"><h1>Needs you <span className="count" title="Open actions only you may take">{requests.length}</span></h1></div>
    <p className="muted">Agents decide everything except goals and priorities, spending money or opening third-party accounts, issuing credentials to people, and authorizing what no agent identity may authorize. An item that reaches one of those waits here without holding a worker; everything else keeps moving.</p>
    {requests.length === 0 ? <p className="muted">Nothing is waiting on you.</p>
      : <div className="cards">{requests.map(row => <RequestCard key={row.request.id} row={row} refusal={refusalFor(row)} busy={busy} open={() => setSelected(row.id)}
        answer={(text, post) => action(row.id, row.answer.post.command, { ...post, [row.answer.post.field]: text })}/>)}</div>}
    {refused && <p className="muted">Sign in with your own (human) operator credential to answer these.</p>}
    {answered.length > 0 && <section className="work-list" aria-label="Recently answered"><h2>Recently answered</h2><ul className="shipped-list">{answered.map(({ item, request }) => <li key={request.id}>
      <button className="text-button" onClick={() => setSelected(item.id)}>{item.key} <span data-title>{item.title}</span></button>
      <span className="muted">{humanDecisionLabel[request.kind]} · {request.answer!.outcome} by {request.answer!.by} after {formatDuration(request.answer!.waitedMs / 60000)}</span>
      <span>{request.answer!.text}</span>
    </li>)}</ul></section>}
  </>;
}

/**
 * One waiting action. The form is the row's own: the rule says what the operator's words are
 * called, what the button reads, and whether there is a refusing answer beside it.
 */
export function RequestCard({ row, refusal, busy, open, answer }: { row: HumanRequestRow; refusal: string | null; busy: boolean; open(): void; answer(text: string, body: Record<string, unknown>): Promise<void> }) {
  const [text, setText] = useState('');
  const post: HumanOnlyPost = row.answer.post;
  const send = (body: Record<string, unknown>) => { if (text.trim()) void answer(text.trim(), body).then(() => setText('')); };
  return <div className="card human-request">
    <div className="card-top"><button className="text-button" onClick={open}>{row.work} <span data-title>{row.title}</span></button><span title={`Asked ${row.request.at}`}>Waiting {formatDuration(row.waitedMs / 60000)}</span></div>
    <h3>{row.request.needed}</h3>
    <p className="reason">{row.decision} · asked by {row.request.requestedBy}: {row.request.reason}</p>
    {refusal ? <p className="muted">This session cannot answer it: {refusal}.</p> : <form onSubmit={event => { event.preventDefault(); send(post.body); }}>
      <textarea aria-label={`${post.field === 'reason' ? 'Reason' : 'Answer'} for ${row.work}`} placeholder="What you decided or provided, in words the next worker can act on…" value={text} onChange={event => setText(event.target.value)} rows={3}/>
      <div className="list-tools"><button type="submit" disabled={busy || !text.trim()}>{post.submit}</button>
        {post.decline && <button type="button" className="text-button" disabled={busy || !text.trim()} onClick={() => send(post.decline!.body)}>{post.decline.submit}</button>}</div>
    </form>}
    <p className="muted">The same thing from a terminal, which you never need: <code>{row.answer.cli}</code></p>
  </div>;
}
