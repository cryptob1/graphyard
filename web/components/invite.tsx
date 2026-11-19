import { useEffect, useState } from 'react';
import Dialog from '../dialog';
import { CopyButton } from '../pages/workers';
import { sealForHost } from '../seal';
import type { Dashboard } from '../pages/dashboard';

type Install = { url: string; name: string };
type Teammate = { login: string; role: string; installs: string[] };
type Access = { hostKey: string | null; tokenSaved: boolean; shareLink: { state: string } | null; installs: Install[]; teammates: Teammate[] };

/**
 * GY-3486: Invite, in the top bar for the operator's human session. One dialog names the people by
 * their Tailscale logins, a role and the installs on this machine; Invite gives one message with
 * Tailscale's share and the install addresses. Tailscale signs them in: there is no Graphyard link.
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
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<{ text: string | null; missing: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => api('team-access').then(setAccess, (e: Error) => setError(e.message));
  useEffect(() => { void load(); }, [api]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  /** With a token saved the machine first makes the Tailscale invite; the dialog waits for it, then records the people. */
  const invite = (form: HTMLFormElement) => act(async () => {
    const data = new FormData(form);
    const body = { logins: String(data.get('logins')).split(/[\s,;]+/).filter(Boolean), role: data.get('role'), installs: data.getAll('installs') };
    let answer = await api('invites', body);
    while (answer.pending) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      const state = await api(`team-access/device-invites/${answer.pending}`);
      if (state.state === 'failed') throw new Error(state.error);
      if (state.state === 'ready') answer = await api('invites', { ...body, deviceInvite: answer.pending });
    }
    setMessage({ text: answer.message, missing: answer.missing });
    setAccess(value => value && { ...value, teammates: answer.teammates });
    (form.elements.namedItem('logins') as HTMLInputElement).value = '';
  });
  const close = <button className="close" aria-label="Close Invite" onClick={onClose}>×</button>;
  return <Dialog onClose={onClose}><section className="modal invite" role="dialog" aria-modal="true" aria-label="Invite">
    {close}
    <h2>Invite</h2>
    {!access ? <p>{error || 'Loading…'}</p> : <>
      {!access.tokenSaved && (!access.shareLink || access.shareLink.state === 'expired') && <form onSubmit={event => { event.preventDefault(); void act(async () => {
        demandKey(access.hostKey);
        setAccess(await api('team-access/tailscale-token', { sealed: await sealForHost(access.hostKey!, token) }));
        setToken('');
      }); }}>
        <p>Paste a Tailscale API token once so each invite includes tailnet access.</p>
        <label>Tailscale API token<input type="password" autoComplete="off" required value={token} onChange={event => setToken(event.target.value)}/></label>
        <button disabled={busy}>Save token</button>
      </form>}
      <form onSubmit={event => { event.preventDefault(); void invite(event.currentTarget); }}>
        <label>Tailscale logins<input name="logins" required placeholder="ana@example.com, bo@example.com"/></label>
        <label htmlFor="invite-role">Role</label><select id="invite-role" name="role" defaultValue="viewer"><option value="viewer">Viewer</option><option value="maintainer">Maintainer</option></select>
        <fieldset><legend>Installs on this machine</legend>
          {access.installs.map(install => <label key={install.url} className="check"><input type="checkbox" name="installs" value={install.url} defaultChecked/>{install.name} {install.url && <span className="mono">{install.url}</span>}</label>)}
        </fieldset>
        <button disabled={busy}>{busy ? 'Inviting…' : 'Invite'}</button>
      </form>
      {error && <p role="alert" className="amber">{error}</p>}
      {message && (message.text
        ? <div role="status"><label htmlFor="invitation-message">Invitation message</label><textarea id="invitation-message" readOnly rows={7} value={message.text}/> <CopyButton text={message.text} label="Copy"/></div>
        : <p className="amber" role="status">{message.missing}</p>)}
      <h3>Teammates</h3>
      {access.teammates.length ? <ul aria-label="Teammates" className="teammates">{access.teammates.map(teammate => <li key={teammate.login}>
        <strong>{teammate.login}</strong> · {teammate.role} · <span className="mono">{teammate.installs.join(', ') || 'this install'}</span>{' '}
        <button type="button" className="text-button" disabled={busy} onClick={() => void act(async () => { await api(`invites/${encodeURIComponent(teammate.login)}/revoke`, {}); await load(); })}>Revoke</button>
      </li>)}</ul> : <p>Nobody is invited yet.</p>}
    </>}
  </section></Dialog>;
}

function demandKey(key: string | null) {
  if (!key) throw new Error('This machine\'s master loop has not reported yet; start it, then save the token.');
}
