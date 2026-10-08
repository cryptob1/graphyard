import { useEffect, useState } from 'react';
import { checklistGreen, goalLimits, goalSubmission, requestedView, setupChecklist, statusSupervised, type SetupItem } from '../../src/model/setup-checklist';
import { findOnboardingWork, onboardingWait, type OnboardingWait } from '../../src/model/onboarding-work';
import { PageHeader, PageSection } from '../components/page-layout';
import type { Dashboard } from './dashboard';

/**
 * The first-run Setup page (GY-1419): the checklist a new installation needs, each item's live
 * state read from the control plane, one plain sentence and one button. `graphyard up` prints this
 * page's address and waits on the same checklist (src/model/setup-checklist.ts). Nothing here names
 * a command, a sha or a file: the person reading it may never open a terminal. Once every item is
 * green it asks what to build and submits that as the first work item.
 */

let opened: string | undefined;
/**
 * The page the address asks for, read once before anything renders (web/main.tsx): `graphyard up`
 * prints a sign-in link ending `&setup`, which opens this page once the person is signed in. The
 * marker leaves the address bar so the sign-in page redeems the exact link fragment it knows.
 */
export function initialView(): string {
  if (opened !== undefined) return opened;
  const requested = requestedView(location.hash);
  if (requested.hash !== location.hash) history.replaceState(null, '', `${location.pathname}${location.search}${requested.hash}`);
  return opened = requested.view ?? 'work';
}

function ItemAction({ item, onConnect }: { item: SetupItem; onConnect: () => void }) {
  const action = item.action;
  if (!action) return null;
  if (action.kind === 'link') return <a className="connect-button" data-setup-action={item.id} href={action.href} target="_blank" rel="noreferrer">{action.label}</a>;
  if (action.kind === 'connect') return <button className="connect-button" data-setup-action={item.id} onClick={onConnect}>{action.label}</button>;
  return <span className="muted" data-setup-action={item.id}>{action.label}</span>;
}

/**
 * The onboarding change as the current setup step (GY-1478): the pull request that adds Graphyard's
 * delivery workflows, filed as a work item the coordinator reviews and merges by itself. It shows
 * what it waits for and how long, with its link, until it merges.
 */
function OnboardingStep({ wait }: { wait: OnboardingWait }) {
  return <li data-setup-item="onboarding" data-done={wait.merged ? 'yes' : 'no'} data-waiting-for={wait.waitingFor.join(' ')} aria-current={wait.merged ? undefined : 'step'}>
    <strong>{wait.merged ? '✓ ' : '○ '}Onboarding change</strong> <span className={wait.merged ? 'green' : 'amber'}>{wait.merged ? 'Done' : wait.closed ? 'Needs you' : 'In progress'}</span>
    <p>{wait.line}</p>
    {wait.url && <a className="connect-button" data-setup-action="onboarding" href={wait.url} target="_blank" rel="noreferrer">Open the change</a>}
  </li>;
}

export function SetupChecklist({ items, onConnect, onboarding }: { items: SetupItem[]; onConnect: () => void; onboarding?: OnboardingWait | null }) {
  return <ol className="setup-checklist" aria-label="First-run checklist">
    {items.map(item => <li key={item.id} data-setup-item={item.id} data-done={item.done ? 'yes' : 'no'}>
      <strong>{item.done ? '✓ ' : '○ '}{item.title}</strong> <span className={item.done ? 'green' : 'amber'}>{item.done ? 'Done' : item.human ? 'Needs you' : 'In progress'}</span>
      <p>{item.line}</p>
      <ItemAction item={item} onConnect={onConnect}/>
    </li>)}
    {onboarding && <OnboardingStep wait={onboarding}/>}
  </ol>;
}

export function GoalForm({ onSubmit, busy, error, submitted }: { onSubmit: (text: string) => void; busy?: boolean; error?: string; submitted?: string | null }) {
  const [text, setText] = useState('');
  if (submitted) return <p className="notice" data-goal-submitted>Thanks — your goal is recorded as {submitted}. Graphyard drafts how it will be accepted, plans it and starts building.</p>;
  return <form aria-label="Describe what you want built" onSubmit={event => { event.preventDefault(); onSubmit(text); }}>
    <label>Describe what you want built<textarea name="goal" rows={5} minLength={goalLimits.min} maxLength={goalLimits.max} required value={text} onChange={event => setText(event.target.value)} placeholder="For example: a sign-up page that sends a welcome email"/></label>
    {error && <p role="alert" className="amber">{error}</p>}
    <button disabled={busy} data-goal-submit>{busy ? 'Sending…' : 'Start building'}</button>
  </form>;
}

/**
 * The page body for a status answer and the work items (WORK, read at NOW), without the dashboard's
 * state: what the tests render. The onboarding change is a step of its own while it is open, so the
 * goal box waits for it as `graphyard up` does. WORKUNREAD: the work items are not read yet (or the
 * read failed), so whether the change merged is unknown and the goal box stays closed.
 */
export function SetupView({ status, work, workUnread, now, onConnect, onSubmitGoal, busy, error, submitted }: { status: any; work?: readonly any[] | null; workUnread?: boolean; now?: number; onConnect: () => void; onSubmitGoal: (text: string) => void; busy?: boolean; error?: string; submitted?: string | null }) {
  // A supervised install (GY-1501) has no reviewer App or reviewing account to set up: the person reviews each change.
  const supervised = statusSupervised(status), items = setupChecklist(status, { supervised });
  const item = findOnboardingWork(work);
  const onboarding = item ? onboardingWait(item, now ?? Date.now(), status?.githubRepository?.fullName ?? status?.githubRepository ?? null) : null;
  const open = onboarding && !onboarding.merged ? 1 : 0;
  const green = checklistGreen(items) && !open && !workUnread;
  const total = items.length + (onboarding ? 1 : 0), left = items.filter(entry => !entry.done).length + open;
  return <>
    <PageHeader title="Set up Graphyard">{green ? 'Everything is ready.' : !left ? 'Checking whether the onboarding change has merged. This page updates by itself.' : `${left} of ${total} steps left. This page updates by itself as each one finishes.`}</PageHeader>
    {supervised && <p className="notice" data-supervised>You review and merge each change on GitHub; no agent reviews or approves on your behalf.</p>}
    <PageSection title="Checklist" label="Setup checklist"><SetupChecklist items={items} onConnect={onConnect} onboarding={onboarding}/></PageSection>
    {green && <PageSection title="Your first goal" label="First goal"><GoalForm onSubmit={onSubmitGoal} busy={busy} error={error} submitted={submitted}/></PageSection>}
  </>;
}

/** The goal box's submit (GY-1443): a goal record through the goals API, as `graphyard goal` records one, never a plain work item. */
export async function submitGoal(api: Dashboard['api'], text: string): Promise<string> {
  const created = await api('goals', goalSubmission(text));
  return created?.key ?? 'a new goal';
}

export default function SetupPage({ status, api, setView }: Pick<Dashboard, 'status' | 'api' | 'setView'>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  // The work items, read while this page is open, so the onboarding change shows as the current step (GY-1478).
  // Until a read answers, whether the change merged is unknown, so the goal box stays closed.
  const [work, setWork] = useState<any[] | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => api('work-snapshot').then(snapshot => { if (live) setWork(Array.isArray(snapshot?.work) ? snapshot.work : null); }, () => { if (live) setWork(null); });
    void read();
    const timer = setInterval(read, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [api]);
  const submit = async (text: string) => {
    setBusy(true); setError('');
    try { setSubmitted(await submitGoal(api, text)); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return <SetupView status={status} work={work} workUnread={work === null} onConnect={() => { location.hash = 'connect'; setView('agents'); }} onSubmitGoal={text => void submit(text)} busy={busy} error={error} submitted={submitted}/>;
}
