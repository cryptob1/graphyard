import { useEffect, useState } from 'react';
import type { Dashboard } from './dashboard';
import { isClosed, type Work } from '../../src/model';
import { blockerSince } from '../../src/model/work';
import { parkedOnHuman } from '../../src/model/human-request';
import { formatAge } from '../../src/model/duration';
import LiveTerminal from '../components/live-terminal';
import { PageHeader } from '../components/page-layout';

type Message = { id: number; from: string; to?: string; thread: string; text: string; at: string; replies: { id: number; by: string; text: string; at: string }[] };
type Entry = { id: number; who: string; text: string; at: string };

/** GY-3345: messages between this Master and other installs' Masters, one thread per conversation, oldest entry first. */
export function messageThreads(messages: Message[]) {
  const threads = new Map<string, { peer: string; entries: Entry[] }>();
  for (const message of messages) {
    const thread = threads.get(message.thread) ?? { peer: message.to ?? message.from, entries: [] };
    thread.entries.push({ id: message.id, who: message.to ? 'Master' : message.from, text: message.text, at: message.at },
      ...message.replies.map(reply => ({ id: reply.id, who: 'Master', text: reply.text, at: reply.at })));
    threads.set(message.thread, thread);
  }
  return [...threads.values()].map(thread => ({ ...thread, entries: thread.entries.sort((a, b) => a.id - b.id) }))
    .sort((a, b) => b.entries.at(-1)!.id - a.entries.at(-1)!.id);
}

/**
 * GY-3394: the blockers the Master owes — every standing worker blocker that is not the owner's,
 * longest wait first, with how long each has stood. The same reading `master status` carries as
 * attention: a blocker is the Master's however long it waits, never the owner's.
 */
export function masterOwes(work: Work[], now: number) {
  return work.filter(item => item.stage !== 'done' && !isClosed(item) && item.blocker && !parkedOnHuman(item))
    .map(item => ({ id: item.id, key: item.key, title: item.title, blocker: item.blocker!, since: blockerSince(item) }))
    .sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
}

/**
 * The Master page (GY-3211): the master agent's live Herdr pane, typed into by the operator and
 * watched by everyone else. Its title reads Master (GY-3307). Above the terminal, what the Master
 * owes: the standing blockers that are the Master's, not the owner's (GY-3394) — Needs you carries
 * only the owner's three decisions.
 */
export default function MasterPage({ work, observedAt, token, api, setSelected }: Pick<Dashboard, 'work' | 'observedAt' | 'token' | 'api' | 'setSelected'>) {
  const [messages, setMessages] = useState<Message[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => api('master/messages').then(body => { if (live) setMessages(body.messages ?? []); }, () => {});
    void load(); const timer = setInterval(load, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [token]);
  const threads = messageThreads(messages);
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const owes = masterOwes(work, now);
  return <>
    <PageHeader title="Master" fact={owes.length ? `${owes.length} ${owes.length === 1 ? 'blocker waits' : 'blockers wait'} on the Master.` : 'Files, routes and unsticks the work.'}/>
    {owes.length > 0 && <section className="panel" aria-label="Blockers the Master owes"><h2>Blockers <small>· the Master clears these</small></h2>
      <ul className="master-owes">{owes.map(entry => <li key={entry.id}>
        <button className="text-button" onClick={() => setSelected(entry.id)}>{entry.key} <span data-title>{entry.title}</span></button>
        <span className="muted">{entry.since !== null ? `blocked ${formatAge(entry.since, now)} ago` : 'blocked'}</span>
        <span className="muted">{entry.blocker}</span>
      </li>)}</ul>
    </section>}
    {threads.length > 0 && <section className="master-messages" aria-label="Messages with other installs">
      {threads.slice(0, 5).map(thread => <article key={thread.entries[0]!.id} className="master-thread" aria-label={`Thread with ${thread.peer}`}>
        <h2>With {thread.peer}</h2>
        <ol>{thread.entries.map(entry => <li key={entry.id}><b>{entry.who}</b> <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time><p>{entry.text}</p></li>)}</ol>
      </article>)}
    </section>}
    <LiveTerminal token={token} label="Master terminal"/>
  </>;
}
