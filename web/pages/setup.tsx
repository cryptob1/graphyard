import { useEffect, useState } from 'react';
import { checklistGreen, paneServer, requestedView, setupChecklist, statusSupervised, type SetupItem } from '../../src/model/setup-checklist';
import { whereLogs, type WhereThingsRun } from '../../src/model/where-things-run';
import { herdrConnectCommands, type HerdrWatch } from '../../src/herdr-connect';
import { CopyButton } from './workers';
import { findOnboardingWork, onboardingWait, type OnboardingWait } from '../../src/model/onboarding-work';
import { PageHeader, PageSection } from '../components/page-layout';
import type { Dashboard } from './dashboard';

/**
 * The first-run Setup page (GY-1419): the checklist a new installation needs, each item's live
 * state read from the control plane, one plain sentence and one button. `graphyard up` prints this
 * page's address and waits on the same checklist (src/model/setup-checklist.ts). The checklist names
 * no command, sha or file: the person reading it may never open a terminal. Once every item is
 * green it asks what to build and submits that as the first work item. Beside it, the commands that
 * open the install's agents in Herdr, for whoever does use a terminal (GY-1511).
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
 * The onboarding change as the current setup step (GY-1478): the commit `graphyard up` published on
 * its branch, filed as a work item the loop reviews and merges by itself. It shows what it waits
 * for and how long, until the change is merged (GY-2938: no pull request, no link to open).
 */
function OnboardingStep({ wait }: { wait: OnboardingWait }) {
  return <li data-setup-item="onboarding" data-done={wait.merged ? 'yes' : 'no'} data-waiting-for={wait.waitingFor.join(' ')} aria-current={wait.merged ? undefined : 'step'}>
    <strong>{wait.merged ? '✓ ' : '○ '}Onboarding change</strong> <span className={wait.merged ? 'green' : 'amber'}>{wait.merged ? 'Done' : wait.closed ? 'Needs you' : 'In progress'}</span>
    <p>{wait.line}</p>
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

/**
 * Where to watch the agents (GY-1511): the copyable commands that attach to the Herdr server holding
 * this install's sessions, on its host and from another machine, and whether that server is running.
 */
export function HerdrConnect({ watch }: { watch: HerdrWatch }) {
  const commands = herdrConnectCommands(watch);
  const rows = [
    { id: 'local', label: 'On this host', text: commands.local },
    { id: 'ssh', label: 'From another machine, through SSH', text: commands.ssh },
    { id: 'remote', label: 'From another machine, with Herdr\'s remote attach', text: commands.remote },
  ];
  return <div data-herdr-connect={watch.session ? 'instance' : 'default'}>
    <p data-herdr-running={watch.running === null ? 'unknown' : watch.running ? 'yes' : 'no'}>
      {watch.running === null ? 'Whether the Herdr server is running is not known yet.' : watch.running ? <span className="green">The Herdr server is running.</span> : <span className="amber">The Herdr server is not running; rerun the setup command on the host to start it.</span>}
      {!watch.host && ' Replace HOST with the machine\'s name or tailnet address.'}
    </p>
    <ul>{rows.map(row => <li key={row.id} data-herdr-command={row.id}>{row.label}: <code>{row.text}</code> <CopyButton text={row.text} label="Copy"/></li>)}</ul>
  </div>;
}

/**
 * Whether the loop tells the operator directly when queued work can neither start nor merge
 * (GY-3101), as the live loop names it in the status (`setup.alerts`): its stall window in minutes
 * (on), false (off), or nothing (no live loop has named it).
 */
export function AlertsLine({ status }: { status: any }) {
  const alerts = status?.setup?.alerts;
  const on = typeof alerts === 'number' && alerts > 0;
  return <p data-alerts={on ? 'on' : alerts === false ? 'off' : 'unknown'}>
    {on ? <span className="green">Alerts are on: when queued work has neither started nor merged for {alerts} minutes, the loop posts to your webhook URL, repeats at most hourly, and posts an all-clear when work moves again.</span>
      : alerts === false ? <span className="amber">Alerts are off. To be told when queued work cannot start or merge, set <code>run.alertUrl</code> in <code>.graphyard/master.json</code> on the host that runs the master loop to a webhook URL that takes a POST, such as an ntfy topic (<code>https://ntfy.sh/your-topic</code>); <code>run.alertMinutes</code> sets the stall window (default 20).</span>
        : 'Whether alerts are on is not known yet: the dashboard learns it from a running master loop. Start the loop on the host with graphyard master run, or check it with graphyard master status.'}
  </p>;
}

/**
 * Where every part of this install runs (GY-3277), as its loop named it (`setup.where`): the units,
 * the containers, the port and URL, the directories and the CLI, each beside the command that reads
 * its logs. The master's Herdr pane (`setup.panes`) rides along, so one panel answers where the
 * loop, the server, the trials and the agents each live. Nothing shows until the loop has named
 * them, the same as the pane server beside it.
 */
export function WhereThingsRunPanel({ where, panes }: { where: WhereThingsRun | null; panes: { session: string | null; master?: string | null } | null }) {
  if (!where) return <p data-where-things-run="unknown" className="muted">Where every part runs is not known yet: the loop names it once it runs. Start the loop on the host with graphyard master run.</p>;
  const rows: { part: string; name: string; logs: string | null }[] = [
    { part: 'Loop (dispatch, merge writer, batch gate)', name: where.loopUnit, logs: whereLogs(where.loopUnit) },
    { part: 'Deploy watch', name: where.deployUnit, logs: whereLogs(where.deployUnit) },
    { part: 'Control-plane server', name: where.server, logs: whereLogs(where.server) },
    { part: 'Database', name: where.database, logs: whereLogs(where.database) },
    { part: 'This dashboard', name: `${where.url} · port ${where.port}`, logs: null },
    { part: 'Merge trials', name: 'a short-lived container per trial, beside any compose services a check declares', logs: null },
    { part: 'Agents (workers, reviewers, producers)', name: `headless on the host, confined in worktrees under ${where.checkout}`, logs: null },
    { part: 'Master session', name: panes?.session ? `Herdr session ${panes.session}${panes.master ? ` · master pane ${panes.master}` : ''}` : 'Herdr', logs: null },
    { part: 'Checkout', name: where.checkout, logs: null },
    { part: 'Install directory (credentials, CLI releases)', name: where.installDirectory, logs: null },
    { part: 'CLI release', name: where.cliPath, logs: null },
  ];
  return <table className="sessions-table" data-where-things-run="known" aria-label="Where things run">
    <thead><tr><th scope="col">Part</th><th scope="col">Runs at</th><th scope="col">Logs</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.part}><th scope="row">{row.part}</th><td data-label="Runs at">{row.name}</td><td data-label="Logs">{row.logs ? <code>{row.logs}</code> : <span className="muted">—</span>}</td></tr>)}</tbody>
  </table>;
}

/**
 * The page body for a status answer and the work items (WORK, read at NOW), without the dashboard's
 * state: what the tests render. The onboarding change is a step of its own while it is open, as
 * `graphyard up` waits for it. WORKUNREAD: the work items are not read yet (or the read failed), so
 * whether the change merged is unknown and the page is not yet green.
 */
export function SetupView({ status, work, workUnread, now, onConnect }: { status: any; work?: readonly any[] | null; workUnread?: boolean; now?: number; onConnect: () => void }) {
  // A supervised install (GY-1501) is set up as any other; it only provisions no approver.
  const supervised = statusSupervised(status), items = setupChecklist(status);
  const item = findOnboardingWork(work);
  const onboarding = item ? onboardingWait(item, now ?? Date.now()) : null;
  const open = onboarding && !onboarding.merged ? 1 : 0;
  const green = checklistGreen(items) && !open && !workUnread;
  const total = items.length + (onboarding ? 1 : 0), left = items.filter(entry => !entry.done).length + open;
  return <>
    <PageHeader title="Set up Graphyard">{green ? 'Everything is ready.' : !left ? 'Checking whether the onboarding change has merged. This page updates by itself.' : `${left} of ${total} steps left. This page updates by itself as each one finishes.`}</PageHeader>
    {supervised && <p className="notice" data-supervised>An agent reviews each change and Graphyard merges it; no agent approves decisions on your behalf, so you answer each one.</p>}
    <PageSection title="Checklist" label="Setup checklist"><SetupChecklist items={items} onConnect={onConnect} onboarding={onboarding}/></PageSection>
    <PageSection title="Where things run" label="Where things run"><WhereThingsRunPanel where={status?.setup?.where ?? null} panes={status?.setup?.panes ?? null}/></PageSection>
    <PageSection title="Watch your agents in Herdr" label="Watch your agents in Herdr"><HerdrConnect watch={paneServer(status)}/></PageSection>
    <PageSection title="Be told when the yard stops" label="Be told when the yard stops"><AlertsLine status={status}/></PageSection>
  </>;
}

type Invitation = { principal: string; role: string; expiresAt: string };

function InviteSomeone({ api }: Pick<Dashboard, 'api'>) {
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [latest, setLatest] = useState<(Invitation & { url: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function revoke(name: string) {
    setBusy(true); setError('');
    try {
      await api(`invites/${encodeURIComponent(name)}/revoke`, {});
      setInvites(rows => rows.filter(row => row.principal !== name));
      setLatest(value => value?.principal === name ? null : value);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <PageSection title="Invite someone" label="Invite someone">
    <p>Send a one-time sign-in link. Viewers can read the yard; maintainers can also file work.</p>
    <form onSubmit={async event => {
      event.preventDefault();
      const form = event.currentTarget, data = new FormData(form);
      setBusy(true); setError('');
      try {
        const { principal, role, expiresAt, code } = await api('invites', { name: String(data.get('name')).trim(), role: data.get('role') });
        const invitation = { principal, role, expiresAt };
        setInvites(rows => [...rows, invitation]);
        setLatest({ ...invitation, url: `${location.origin}/#sign-in=${code}` });
        form.reset();
      } catch (e) { setError((e as Error).message); }
      finally { setBusy(false); }
    }}>
      <label>Name<input name="name" required maxLength={100} placeholder="Email or GitHub login"/></label>
      <label htmlFor="invite-role">Role</label><select id="invite-role" name="role" defaultValue="viewer"><option value="viewer">Viewer</option><option value="maintainer">Maintainer</option></select>
      <button disabled={busy}>Invite</button>
    </form>
    {error && <p role="alert" className="amber">{error}</p>}
    {latest && <div role="status">
      <p>One-time sign-in link for {latest.principal} ({latest.role}). Link expires <time dateTime={latest.expiresAt}>{new Date(latest.expiresAt).toLocaleString()}</time>.</p>
      <label>Sign-in link<input readOnly value={latest.url}/></label> <CopyButton text={latest.url} label="Copy"/>
    </div>}
    <h3>Invited from this page</h3>
    <p className="muted">This list resets when you leave or reload Setup. Revoke ends their sessions and cancels unused links.</p>
    {invites.length ? <ul aria-label="Invited from this page">{invites.map((invite, index) => <li key={index}>
      <strong>{invite.principal}</strong> — {invite.role} · Link expires <time dateTime={invite.expiresAt}>{new Date(invite.expiresAt).toLocaleString()}</time> <button disabled={busy} onClick={() => void revoke(invite.principal)}>Revoke</button>
    </li>)}</ul> : <p>No invitations from this page yet.</p>}
  </PageSection>;
}

export default function SetupPage({ status, api, setView }: Pick<Dashboard, 'status' | 'api' | 'setView'>) {
  // The work items, read while this page is open, so the onboarding change shows as the current step (GY-1478).
  const [work, setWork] = useState<any[] | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => api('work-snapshot').then(snapshot => { if (live) setWork(Array.isArray(snapshot?.work) ? snapshot.work : null); }, () => { if (live) setWork(null); });
    void read();
    const timer = setInterval(read, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [api]);
  return <><SetupView status={status} work={work} workUnread={work === null} onConnect={() => { location.hash = 'connect'; setView('agents'); }}/>{status?.actor?.role === 'admin' && status.actor.sessionKind === 'human' && <InviteSomeone api={api}/>}</>;
}
