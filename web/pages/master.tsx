import { useEffect, useState } from 'react';
import type { Dashboard } from './dashboard';
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

/** The Master page (GY-3211): the master agent's live Herdr pane, typed into by the operator and watched by everyone else. Its title reads Master (GY-3307). */
export default function MasterPage({ token, api }: Pick<Dashboard, 'token' | 'api'>) {
  const [messages, setMessages] = useState<Message[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => api('master/messages').then(body => { if (live) setMessages(body.messages ?? []); }, () => {});
    void load(); const timer = setInterval(load, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [token]);
  const threads = messageThreads(messages);
  return <>
    <PageHeader title="Master" fact="Files, routes and unsticks the work."/>
    {threads.length > 0 && <section className="master-messages" aria-label="Messages with other installs">
      {threads.slice(0, 5).map(thread => <article key={thread.entries[0]!.id} className="master-thread" aria-label={`Thread with ${thread.peer}`}>
        <h2>With {thread.peer}</h2>
        <ol>{thread.entries.map(entry => <li key={entry.id}><b>{entry.who}</b> <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time><p>{entry.text}</p></li>)}</ol>
      </article>)}
    </section>}
    <LiveTerminal token={token} label="Master terminal"/>
  </>;
}
