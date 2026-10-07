import { useState } from 'react';
import { checklistGreen, goalLimits, goalWorkItem, setupChecklist, type SetupItem } from '../../src/model/setup-checklist';
import { PageHeader, PageSection } from '../components/page-layout';
import type { Dashboard } from './dashboard';

/**
 * The first-run Setup page (GY-1419): the checklist a new installation needs, each item's live
 * state read from the control plane, one plain sentence and one button. `graphyard up` prints this
 * page's address and waits on the same checklist (src/model/setup-checklist.ts). Nothing here names
 * a command, a sha or a file: the person reading it may never open a terminal. Once every item is
 * green it asks what to build and submits that as the first work item.
 */

function ItemAction({ item, onConnect }: { item: SetupItem; onConnect: () => void }) {
  const action = item.action;
  if (!action) return null;
  if (action.kind === 'link') return <a className="connect-button" data-setup-action={item.id} href={action.href} target="_blank" rel="noreferrer">{action.label}</a>;
  if (action.kind === 'connect') return <button className="connect-button" data-setup-action={item.id} onClick={onConnect}>{action.label}</button>;
  return <span className="muted" data-setup-action={item.id}>{action.label}</span>;
}

export function SetupChecklist({ items, onConnect }: { items: SetupItem[]; onConnect: () => void }) {
  return <ol className="setup-checklist" aria-label="First-run checklist">
    {items.map(item => <li key={item.id} data-setup-item={item.id} data-done={item.done ? 'yes' : 'no'}>
      <strong>{item.done ? '✓ ' : '○ '}{item.title}</strong> <span className={item.done ? 'green' : 'amber'}>{item.done ? 'Done' : item.human ? 'Needs you' : 'In progress'}</span>
      <p>{item.line}</p>
      <ItemAction item={item} onConnect={onConnect}/>
    </li>)}
  </ol>;
}

export function GoalForm({ onSubmit, busy, error, submitted }: { onSubmit: (text: string) => void; busy?: boolean; error?: string; submitted?: string | null }) {
  const [text, setText] = useState('');
  if (submitted) return <p className="notice" data-goal-submitted>Thanks — your goal is on the board as {submitted}. Graphyard plans it and starts building.</p>;
  return <form aria-label="Describe what you want built" onSubmit={event => { event.preventDefault(); onSubmit(text); }}>
    <label>Describe what you want built<textarea name="goal" rows={5} minLength={goalLimits.min} maxLength={goalLimits.max} required value={text} onChange={event => setText(event.target.value)} placeholder="For example: a sign-up page that sends a welcome email"/></label>
    {error && <p role="alert" className="amber">{error}</p>}
    <button disabled={busy} data-goal-submit>{busy ? 'Sending…' : 'Start building'}</button>
  </form>;
}

/** The page body for a status answer, without the dashboard's state: what the tests render. */
export function SetupView({ status, onConnect, onSubmitGoal, busy, error, submitted }: { status: any; onConnect: () => void; onSubmitGoal: (text: string) => void; busy?: boolean; error?: string; submitted?: string | null }) {
  const items = setupChecklist(status);
  const green = checklistGreen(items);
  const left = items.filter(item => !item.done).length;
  return <>
    <PageHeader title="Set up Graphyard">{green ? 'Everything is ready.' : `${left} of ${items.length} steps left. This page updates by itself as each one finishes.`}</PageHeader>
    <PageSection title="Checklist" label="Setup checklist"><SetupChecklist items={items} onConnect={onConnect}/></PageSection>
    {green && <PageSection title="Your first goal" label="First goal"><GoalForm onSubmit={onSubmitGoal} busy={busy} error={error} submitted={submitted}/></PageSection>}
  </>;
}

export default function SetupPage({ status, api, setView }: Pick<Dashboard, 'status' | 'api' | 'setView'>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const submit = async (text: string) => {
    setBusy(true); setError('');
    try { const created = await api('work', goalWorkItem(text)); setSubmitted(created?.key ?? 'a new item'); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return <SetupView status={status} onConnect={() => { location.hash = 'connect'; setView('agents'); }} onSubmitGoal={text => void submit(text)} busy={busy} error={error} submitted={submitted}/>;
}
