import { useState } from 'react';
import { humanDecisionLabel, humanOnlyRefusal, openHumanOnly, parkRule, type HumanOnlyChoice, type HumanOnlyPost, type HumanRequestRow } from '../../src/model/human-request';
import type { Work } from '../../src/model/work';
import { formatDuration } from '../../src/model/duration';
import { shortShas } from '../../src/model/format';
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
export default function HumanRequestsPage({ work, status, observedAt, action, busy, setSelected, signOut }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  // The rows the server derived from the rule table. A client whose status read has not landed
  // yet still sees every rule whose instances live on the work documents it already holds,
  // derived here from that same table.
  // The research brief's product questions (GY-259) are goals-and-priorities requests that hold
  // nothing: each item is already building on the recommended answer, so they are listed beside
  // the rule table's rows with that recommendation and the deadline, and answered the same way.
  const requests: HumanRequestRow[] = [...(status?.humanOnly ?? openHumanOnly(work.map(item => ({ work: item })), now)), ...researchQuestionRows(work, now)]
    .sort((a, b) => b.waitedMs - a.waitedMs);
  const answered = work.flatMap(item => (item.humanRequests ?? []).filter(request => request.answer).map(request => ({ item, request })))
    .sort((a, b) => b.request.answer!.at.localeCompare(a.request.answer!.at)).slice(0, 10);
  // Only the operator's own session may answer: the server refuses anything else with the very
  // words the rule carries, so a session it refuses is shown the refusal instead of the form.
  const refusalFor = (row: HumanRequestRow) => humanOnlyRefusal(row.rule === researchQuestionRule ? parkRule.kind : row.rule, status?.actor ?? {});
  const actor = status?.actor;
  return <>
    <div className="page-heading"><h1>Needs you <span className="count" title="Open actions only you may take">{requests.length}</span></h1></div>
    {actor && <p className="muted signed-in-as">Signed in as <strong>{actor.displayName ?? actor.id}</strong> · {signedInAs(actor)}</p>}
    <p className="muted">Agents decide everything except goals and priorities, spending money or opening third-party accounts, issuing credentials to people, and authorizing what no agent identity may authorize. An item that reaches one of those waits here without holding a worker; everything else keeps moving.</p>
    {requests.length === 0 ? <p className="muted">Nothing is waiting on you.</p>
      : <div className="cards">{requests.map(row => <RequestCard key={row.request.id} row={row} refusal={refusalFor(row)} busy={busy} open={() => setSelected(row.id)} signIn={signOut}
        answer={(text, post) => action(row.id, row.answer.post.command, { ...post, [row.answer.post.field]: text })} send={body => action(row.id, row.answer.post.command, body)}/>)}</div>}
    {answered.length > 0 && <section className="work-list" aria-label="Recently answered"><h2>Recently answered</h2><ul className="shipped-list">{answered.map(({ item, request }) => <li key={request.id}>
      <button className="text-button" onClick={() => setSelected(item.id)}>{item.key} <span data-title>{item.title}</span></button>
      <span className="muted">{humanDecisionLabel[request.kind]} · {request.answer!.outcome} by {request.answer!.by} after {formatDuration(request.answer!.waitedMs / 60000)}</span>
      <span>{shortShas(request.answer!.text)}</span>
    </li>)}</ul></section>}
  </>;
}

/** The rule name a research question's row carries; it is answered under the park rule's refusal, as every goals-and-priorities request is. */
export const researchQuestionRule = 'research-question';
/**
 * Every unanswered product question a research brief asked (src/research.ts), as a row of the
 * Needs you list: the question, why it matters, the recommended answer the build already
 * proceeds on, and the deadline. The answer is posted to `research-answer`; it never parks or
 * releases the item, and one that differs from the recommendation returns a built head for rework.
 */
export function researchQuestionRows(work: readonly Pick<Work, 'id' | 'key' | 'title' | 'stage' | 'epoch' | 'researchBrief'>[], now: number): HumanRequestRow[] {
  return work.filter(item => item.stage !== 'done').flatMap(item => (item.researchBrief?.questions ?? []).filter(question => !question.answer).map(question => ({
    rule: researchQuestionRule, work: item.key, id: item.id, title: item.title,
    request: { id: question.id, kind: question.kind, needed: question.question, requestedBy: 'the research step',
      reason: `${question.why} Recommended: ${question.recommendation}. The build proceeds on this recommendation, provisionally; answer by ${question.deadline} to settle it before the head is built.`,
      epoch: item.epoch, at: question.at },
    waitedMs: Math.max(0, now - Date.parse(question.at)), decision: humanDecisionLabel[question.kind],
    refusal: parkRule.refuse({ id: 'an agent identity', role: 'operator-agent', sessionKind: 'ai' })!,
    choices: [{ label: 'Use the recommendation', input: 'none', declines: false, body: { question: question.id, answer: question.recommendation }, note: null },
      { label: 'Answer differently…', input: 'text', declines: false, body: { question: question.id }, note: 'answer' }] satisfies HumanOnlyChoice[],
    answer: { cli: `POST /api/work/${item.key}/research-answer {"question":"${question.id}","answer":"…"}`, decline: 'Leave it unanswered: the recommendation stands',
      dashboard: 'Work → Needs you → Answer', api: `POST /api/work/${item.key}/research-answer {"question":"${question.id}","answer":"…"}`,
      post: { command: 'research-answer', body: { question: question.id }, field: 'answer', submit: `Answer for ${item.key}`, decline: null } },
  })));
}

/** Who this session is, as the Needs you page says it: the operator's human session, or what else it is. */
export function signedInAs(actor: { role?: string | null; sessionKind?: string | null }) {
  return actor.role === 'admin' && actor.sessionKind === 'human' ? 'human operator' : `${actor.role ?? 'unknown role'} (${actor.sessionKind ?? 'undeclared'} session)`;
}
/** The one action a session that may not answer is offered (GY-738): sign in as the operator, never a command to run. */
export const signInAction = 'Sign in as the operator';

/**
 * One waiting action. Its choices are buttons, each one click (GY-738): a note beside them is
 * optional, except for a choice that asks for words (a different cap) or a secret (sealed to the
 * requesting host). A session the rule refuses is told why and offered the operator's sign-in.
 * Free words and the terminal equivalent stay available, folded away, never the primary path.
 */
export function RequestCard({ row, refusal, busy, open, answer, send, signIn }: { row: HumanRequestRow; refusal: string | null; busy: boolean; open(): void; answer(text: string, body: Record<string, unknown>): Promise<void>; send?(body: Record<string, unknown>): Promise<void>; signIn?(): void }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [secret, setSecret] = useState('');
  const post: HumanOnlyPost = row.answer.post;
  const choices = row.choices ?? [];
  const submit = (body: Record<string, unknown>) => { if (text.trim()) void answer(text.trim(), body).then(() => setText('')); };
  const choose = (choice: HumanOnlyChoice) => {
    const body = { ...choice.body, ...(choice.note && note.trim() ? { [choice.note]: note.trim() } : {}), ...(choice.input === 'secret' ? { secret } : {}) };
    void (send ? send(body) : answer('', body)).then(() => { setNote(''); setSecret(''); });
  };
  const ready = (choice: HumanOnlyChoice) => !busy && (choice.input !== 'text' || !!note.trim()) && (choice.input !== 'secret' || !!secret);
  return <div className="card human-request">
    <div className="card-top"><button className="text-button" onClick={open}>{row.work} <span data-title>{row.title}</span></button><span title={`Asked ${row.request.at}`}>Waiting {formatDuration(row.waitedMs / 60000)}</span></div>
    <h3>{shortShas(row.request.needed)}</h3>
    <p className="reason">{row.decision} · asked by {row.request.requestedBy}: {shortShas(row.request.reason)}</p>
    {refusal ? <div className="login-actions"><p className="muted">This session cannot answer it: {shortShas(refusal)}.</p>{signIn && <button type="button" onClick={signIn}>{signInAction}</button>}</div> : <>
      {choices.length > 0 && <form onSubmit={event => event.preventDefault()}>
        {choices.some(choice => choice.input === 'secret') && <label>Value to provide (sealed to the requesting host, never stored as typed)<input type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)}/></label>}
        {choices.some(choice => choice.note) && <textarea aria-label={`Note for ${row.work}`} placeholder="Note (optional; needed for a choice ending in …)" value={note} onChange={event => setNote(event.target.value)} rows={2}/>}
        {/* The shared wrapping action row: buttons wrap at any width, down to 375 px. */}
        <div className="pulse-actions human-choices">{choices.map(choice => <button key={choice.label} type="button" className={choice.declines ? 'text-button' : undefined} disabled={!ready(choice)} onClick={() => choose(choice)}>{choice.label}</button>)}</div>
      </form>}
      <details className="own-words" open={choices.length === 0}><summary className="muted">{choices.length ? 'Or answer in your own words' : 'Answer'}</summary><form onSubmit={event => { event.preventDefault(); submit(post.body); }}>
        <textarea aria-label={`${post.field === 'reason' ? 'Reason' : 'Answer'} for ${row.work}`} placeholder="What you decided or provided, in words the next worker can act on…" value={text} onChange={event => setText(event.target.value)} rows={3}/>
        <div className="list-tools"><button type="submit" disabled={busy || !text.trim()}>{post.submit}</button>
          {post.decline && <button type="button" className="text-button" disabled={busy || !text.trim()} onClick={() => submit(post.decline!.body)}>{post.decline.submit}</button>}</div>
      </form></details>
      <details><summary className="muted">From a terminal</summary><code>{row.answer.cli}</code></details>
    </>}
  </div>;
}
