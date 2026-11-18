import { useEffect, useState } from 'react';
import { checklistGreen, paneServer, requestedView, setupChecklist, statusSupervised, type SetupItem } from '../../src/model/setup-checklist';
import { whereLogs, type WhereThingsRun } from '../../src/model/where-things-run';
import { herdrConnectCommands, type HerdrWatch } from '../../src/herdr-connect';
import { CopyButton } from './workers';
import { sealForHost } from '../seal';
import { findOnboardingWork, onboardingWait, type OnboardingWait } from '../../src/model/onboarding-work';
import { MoreDetails, PageHeader, PageSection } from '../components/page-layout';
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
export function initialView(pages: readonly string[]): string {
  if (opened !== undefined) return opened;
  const requested = requestedView(location.hash, pages);
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
  return <div data-alerts={on ? 'on' : alerts === false ? 'off' : 'unknown'}>
    <p title={on ? `When queued work has neither started nor merged for ${alerts} minutes, the loop posts to your webhook URL, repeats at most hourly, and posts an all-clear when work moves again.` : undefined}>
      {on ? <span className="green">Stall alerts: on (after {alerts} min)</span> : alerts === false ? <span className="amber">Stall alerts: off</span> : 'Stall alerts: not known yet'}
    </p>
    {alerts === false && <MoreDetails summary="Turn them on">To be told when queued work cannot start or merge, set <code>run.alertUrl</code> in <code>.graphyard/master.json</code> on the host that runs the master loop to a webhook URL that takes a POST, such as an ntfy topic (<code>https://ntfy.sh/your-topic</code>); <code>run.alertMinutes</code> sets the stall window (default 20).</MoreDetails>}
    {!on && alerts !== false && <MoreDetails summary="Why">The dashboard learns it from a running master loop. Start the loop on the host with <code>graphyard master run</code>, or check it with <code>graphyard master status</code>.</MoreDetails>}
  </div>;
}

/**
 * Where this install's parts run (GY-3277), as its loop named them (`setup.where`): the units and
 * containers beside the command that reads their logs, then the URL, the master's Herdr pane and the
 * directories. Collapsed at the foot of the page: onboarding does not need it, operating does.
 * `graphyard guide infra` explains each part; this shows only this install's own names.
 */
export function WhereThingsRunPanel({ where, panes }: { where: WhereThingsRun | null; panes: { session: string | null; master?: string | null } | null }) {
  if (!where) return <p data-where-things-run="unknown" className="muted">Not known yet: the loop names these once it runs (graphyard master run).</p>;
  const rows: [string, string][] = [['The loop', where.loopUnit], ['Deploy watch', where.deployUnit], ['Server and dashboard', where.server], ['Database', where.database]];
  return <div data-where-things-run="known">
    <table className="sessions-table" aria-label="Where things run">
      <thead><tr><th scope="col">Part</th><th scope="col">Runs as</th><th scope="col">Logs</th></tr></thead>
      <tbody>{rows.map(([part, name]) => { const logs = whereLogs(name); return <tr key={part}><th scope="row">{part}</th><td data-label="Runs as">{name}</td><td data-label="Logs">{logs ? <code>{logs}</code> : <span className="muted">—</span>}</td></tr>; })}</tbody>
    </table>
    <p className="muted">Dashboard {where.url} (port {where.port}){panes?.session ? ` · Herdr session ${panes.session}${panes.master ? `, master pane ${panes.master}` : ''}` : ''} · checkout {where.checkout} · install directory {where.installDirectory}. <code>graphyard guide infra</code> explains each part.</p>
  </div>;
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
    <PageHeader title="Set up Graphyard" fact={green ? 'Everything is ready.' : !left ? 'Checking whether the onboarding change has merged.' : `${left} of ${total} steps left.`}/>
    {supervised && <p className="notice" data-supervised>An agent reviews each change and Graphyard merges it; no agent approves decisions on your behalf, so you answer each one.</p>}
    <PageSection title="Checklist" label="Setup checklist"><SetupChecklist items={items} onConnect={onConnect} onboarding={onboarding}/></PageSection>
    <PageSection title="Be told when the yard stops" label="Be told when the yard stops"><AlertsLine status={status}/></PageSection>
    <section className="panel" aria-label="Watch agents in a terminal"><MoreDetails summary="Watch agents in a terminal"><HerdrConnect watch={paneServer(status)}/></MoreDetails></section>
    <section className="panel" aria-label="Where things run"><MoreDetails summary="Where things run"><WhereThingsRunPanel where={status?.setup?.where ?? null} panes={status?.setup?.panes ?? null}/></MoreDetails></section>
  </>;
}

type Invitation = { principal: string; role: string; expiresAt: string };
type ShareLink = { url: string; createdOn: string; expiresAt: string; state: 'ok' | 'refresh' | 'expired' };
type TeamAccess = { summary: string; port: string; installUrl: string | null; hostSynced: boolean; hostKey: string | null; mode: 'api' | 'reusable'; shareLink: ShareLink | null; guidance: string | null; acl: string; aclGuidance: string };
type Invited = Invitation & { link: string | null; message: string | null; missing: string | null };

const day = (iso: string) => <time dateTime={iso}>{new Date(iso).toLocaleDateString()}</time>;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * GY-3294: the machine's Tailscale access every install on it shares (src/team-access.ts): the share
 * link pasted once for the machine with the day it was made, or the optional API token (sealed to the
 * host in this browser, never shown again), and the policy grant that keeps a teammate on this port.
 */
function MachineAccess({ api, access, setAccess }: Pick<Dashboard, 'api'> & { access: TeamAccess; setAccess(value: TeamAccess): void }) {
  const [error, setError] = useState('');
  const [link, setLink] = useState(''), [made, setMade] = useState(today), [token, setToken] = useState('');
  const save = (path: string, body: () => Promise<object> | object, clear: () => void) => async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError('');
    try { setAccess(await api(path, await body())); clear(); } catch (e) { setError((e as Error).message); }
  };
  const share = access.shareLink;
  return <div aria-label="Team access on this machine" role="group">
    <p>{access.summary}</p>
    <p>{access.installUrl ? <>This install: <a href={access.installUrl}>{access.installUrl}</a> (port {access.port}).</> : <>This install is on port {access.port}.</>}</p>
    {share ? <p data-share-state={share.state} className={share.state === 'ok' ? undefined : 'amber'}>
      Machine share link (reusable, shared by every install here): <a href={share.url}>{share.url}</a> <CopyButton text={share.url} label="Copy share link"/>. Made {share.createdOn}; Tailscale expires it {day(share.expiresAt)}.
      {share.state === 'refresh' && ' It expires within seven days: make a fresh one and paste it below.'}
      {share.state === 'expired' && ' It has expired: make a fresh one and paste it below before inviting anyone.'}
    </p> : null}
    {access.guidance && <p className="amber" data-share-state="missing">{access.guidance}</p>}
    <form onSubmit={save('team-access/share-link', () => ({ url: link, createdOn: made }), () => { setLink(''); setMade(today()); })}>
      <label>Tailscale share link<input name="link" value={link} onChange={event => setLink(event.target.value)} required placeholder="https://login.tailscale.com/…"/></label>
      <label>Made on<input type="date" name="createdOn" value={made} onChange={event => setMade(event.target.value)} required/></label>
      <button>Save for this machine</button>
    </form>
    <MoreDetails summary="Optional: a single-use Tailscale invite per person">
      <p>Save a Tailscale API access token and each invite makes its own single-use device invite instead of the reusable link. This browser seals it to this machine; only the machine opens it, keeps it in an owner-only file, and it is never shown again.</p>
      <p>{access.mode === 'api' ? 'A token is saved: invites make single-use Tailscale links.' : 'No token is saved: invites use the machine share link.'}</p>
      {access.hostKey ? <form onSubmit={save('team-access/tailscale-token', async () => token ? { sealed: await sealForHost(access.hostKey!, token) } : { remove: true }, () => setToken(''))}>
        <label>Tailscale API token<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)}/></label>
        <button>{token ? 'Save token' : 'Remove token'}</button>
      </form> : <p>The master loop on this machine has not reported yet; the token can be saved once it runs.</p>}
    </MoreDetails>
    <MoreDetails summary="Optional: keep shared people on this install's port">
      <p>A tailnet policy grant for you to apply in the Tailscale admin console: it lets the teammate reach this machine on port {access.port} only.</p>
      <pre aria-label="ACL example">{access.acl}</pre> <CopyButton text={access.acl} label="Copy grant"/>
      <p>{access.aclGuidance}</p>
    </MoreDetails>
    {error && <p role="alert" className="amber">{error}</p>}
  </div>;
}

function InviteSomeone({ api }: Pick<Dashboard, 'api'>) {
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [latest, setLatest] = useState<Invited | null>(null);
  const [retry, setRetry] = useState<{ name: string; role: unknown } | null>(null);
  const [access, setAccess] = useState<TeamAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api('team-access').then(setAccess, () => setAccess(null)); }, [api]);
  /** One Invite: with an API token the machine first makes the single-use Tailscale invite, then the Graphyard one; a failure offers a retry or the share link, never half a message. */
  async function send(body: { name: string; role: unknown; origin: string; share?: 'reusable' }): Promise<boolean> {
    setError(''); setRetry(null);
    try {
      let answer = await api('invites', body);
      if (answer.pending) {
        for (;;) {
          await new Promise(resolve => setTimeout(resolve, 1_000));
          const state = await api(`team-access/device-invites/${answer.pending}`);
          if (state.state === 'failed') { setError(state.error); setRetry({ name: body.name, role: body.role }); return false; }
          if (state.state === 'ready') { answer = await api('invites', { ...body, deviceInvite: answer.pending }); break; }
        }
      }
      const { principal, role, expiresAt, link, message, missing } = answer;
      setInvites(rows => [...rows, { principal, role, expiresAt }]);
      setLatest({ principal, role, expiresAt, link, message, missing });
      return true;
    } catch (e) { setError((e as Error).message); return false; }
  }  async function revoke(name: string) {
    setBusy(true); setError('');
    try {
      await api(`invites/${encodeURIComponent(name)}/revoke`, {});
      setInvites(rows => rows.filter(row => row.principal !== name));
      setLatest(value => value?.principal === name ? null : value);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <PageSection title="Invite someone" label="Invite someone">
    {access && <MachineAccess api={api} access={access} setAccess={setAccess}/>}
    <p>Invite makes one message with both links: the machine's Tailscale share (the reusable link, or a single-use invite when an API token is saved) and this install's own Graphyard sign-in link, single use, valid 24 hours. Viewers can read the yard; maintainers can also file work.</p>
    <form onSubmit={async event => {
      event.preventDefault();
      const form = event.currentTarget, data = new FormData(form);
      setBusy(true); setError('');
      try {
        const invited = await send({ name: String(data.get('name')).trim(), role: data.get('role'), origin: location.origin });
        if (invited) form.reset();
      } finally { setBusy(false); }
    }}>
      <label>Name<input name="name" required maxLength={100} placeholder="Email or GitHub login"/></label>
      <label htmlFor="invite-role">Role</label><select id="invite-role" name="role" defaultValue="viewer"><option value="viewer">Viewer</option><option value="maintainer">Maintainer</option></select>
      <button disabled={busy}>Invite</button>
    </form>
    {error && <p role="alert" className="amber">{error}</p>}
    {retry && <p>
      <button disabled={busy} onClick={() => void send({ ...retry, origin: location.origin })}>Try again</button>
      {access?.shareLink && access.shareLink.state !== 'expired' && <> <button disabled={busy} onClick={() => void send({ ...retry, origin: location.origin, share: 'reusable' })}>Use the machine share link instead</button></>}
    </p>}
    {latest && <div role="status">
      <p>One-time sign-in link for {latest.principal} ({latest.role}). Link expires <time dateTime={latest.expiresAt}>{new Date(latest.expiresAt).toLocaleString()}</time>.</p>
      {latest.message ? <><label htmlFor="invitation-message">Invitation message</label><textarea id="invitation-message" readOnly rows={7} value={latest.message}/> <CopyButton text={latest.message} label="Copy message"/></>
        : <p className="amber" data-invite-missing>No ready-to-send message yet: {latest.missing}</p>}
      {latest.link && <><label>Sign-in link<input readOnly value={latest.link}/></label> <CopyButton text={latest.link} label="Copy"/></>}
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
