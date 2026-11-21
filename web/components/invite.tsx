import { useEffect, useState } from 'react';
import Dialog from '../dialog';
import { CopyButton } from '../pages/workers';
import type { Dashboard } from '../pages/dashboard';

type Teammate = { login: string; role: string };
type Access = { guidance: string | null; teammates: Teammate[] };

/**
 * GY-3514: Invite, in the top bar for the operator's human session. Name a person, a role and how long
 * the link stays valid; Invite gives one link that signs them in once, on any device.
 */
export default function Invite({ api, status }: Pick<Dashboard, 'api' | 'status'>) {
  const [open, setOpen] = useState(false);
  if (status?.actor?.role !== 'admin' || status.actor.sessionKind !== 'human') return null;
  return <>
    <button type="button" className="invite-button" onClick={() => setOpen(true)}>Invite</button>
    {open && <InviteDialog api={api} onClose={() => setOpen(false)}/>}
  </>;
}

function InviteDialog({ api, onClose }: Pick<Dashboard, 'api'> & { onClose(): void }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [link, setLink] = useState<{ link: string; note: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => api('team-access').then(setAccess, (e: Error) => setError(e.message));
  useEffect(() => { void load(); }, [api]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const invite = (form: HTMLFormElement) => act(async () => {
    const data = new FormData(form);
    setLink(await api('invites', { name: String(data.get('name')).trim(), role: data.get('role'), days: Number(data.get('days')) }));
    (form.elements.namedItem('name') as HTMLInputElement).value = '';
    await load();
  });
  return <Dialog onClose={onClose}><section className="modal invite" role="dialog" aria-modal="true" aria-label="Invite">
    <button className="close" aria-label="Close Invite" onClick={onClose}>×</button>
    <h2>Invite</h2>
    {!access ? <p>{error || 'Loading…'}</p> : <>
      <form onSubmit={event => { event.preventDefault(); void invite(event.currentTarget); }}>
        <label>Name<input name="name" required placeholder="ana@example.com"/></label>
        <label htmlFor="invite-role">Role</label><select id="invite-role" name="role" defaultValue="viewer"><option value="viewer">Viewer</option><option value="maintainer">Maintainer</option></select>
        <label htmlFor="invite-days">Link valid for</label><select id="invite-days" name="days" defaultValue="7"><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option></select>
        <button disabled={busy}>{busy ? 'Inviting…' : 'Invite'}</button>
      </form>
      {error && <p role="alert" className="amber">{error}</p>}
      {link && <div role="status">
        <label htmlFor="invite-link">Invite link · opens once</label><input id="invite-link" className="mono" readOnly value={link.link}/> <CopyButton text={link.link} label="Copy"/>
        {link.note && <p className="amber">{link.note}</p>}
      </div>}
      {!link && access.guidance && <p className="amber" role="status">{access.guidance}</p>}
      <h3>Teammates</h3>
      {access.teammates.length ? <ul aria-label="Teammates" className="teammates">{access.teammates.map(teammate => <li key={teammate.login}>
        <strong>{teammate.login}</strong> · {teammate.role}{' '}
        <button type="button" className="text-button" disabled={busy} onClick={() => void act(async () => { await api(`invites/${encodeURIComponent(teammate.login)}/revoke`, {}); await load(); })}>Revoke</button>
      </li>)}</ul> : <p>Nobody is invited yet.</p>}
    </>}
  </section></Dialog>;
}
