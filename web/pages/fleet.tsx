import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { capabilityTiers, fleetRoles, looksLikeSecret, quotaStates, type FleetAccountView, type FleetView, type RolePolicy } from '../../src/model/registry';
import { sealForHost } from '../seal';
import type { Dashboard } from './dashboard';

const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—';
const cost = (account: FleetAccountView) => account.cost && (account.cost.inputPerMTok !== null || account.cost.outputPerMTok !== null)
  ? `$${account.cost.inputPerMTok ?? '?'} in / $${account.cost.outputPerMTok ?? '?'} out per MTok` : 'cost not recorded';

/** A connect an operator made from this page, as the control plane reports it. */
export interface ConnectView {
  id: string; at: string; updatedAt: string; host: string; provider: string;
  state: 'pending' | 'claimed' | 'connecting' | 'waiting-login' | 'healthy' | 'failed' | 'cancelled';
  name: string | null; home: string | null; url: string | null; code: string | null;
  error: string | null; detail: string | null; placement: string[] | null; worker: string | null;
}
export interface ConnectProviderView { id: string; label: string; kind: 'api-key' | 'subscription'; tier: string; help: string }
export interface ConnectHostView { host: string; publicKey?: string; registeredAt: string }

const openState = (state: ConnectView['state']) => state === 'pending' || state === 'claimed' || state === 'connecting' || state === 'waiting-login';
const stateText = (connect: ConnectView) => connect.state === 'waiting-login' ? 'Waiting for you to finish the sign-in'
  : openState(connect.state) ? 'Connecting…'
  : connect.state === 'healthy' ? 'Connected' : connect.state === 'failed' ? 'Failed' : 'Cancelled';

/** One connect in flight or finished: what the provider's login printed, and why it failed when it did. */
export function ConnectCard({ connect, onCancel }: { connect: ConnectView; onCancel?: (id: string) => void }) {
  return <div className="criterion" data-connect={connect.id} data-provider={connect.provider}>
    <strong className={connect.state === 'failed' ? 'amber' : undefined}>{connect.provider} · {stateText(connect)}{connect.name ? ` · ${connect.name}` : ''}</strong>
    {(connect.url || connect.code) && <p data-connect-login={connect.state}>{connect.state === 'waiting-login' ? 'Finish the sign-in in your own browser:' : 'Signed in'}{connect.url ? <> <a href={connect.url} rel="noreferrer">{connect.url}</a></> : null}{connect.url && connect.code ? ' · code ' : connect.code ? ' code ' : null}{connect.code ? <code data-connect-code>{connect.code}</code> : null}</p>}
    {connect.state === 'failed' && connect.error && <p role="alert" className="amber" data-connect-error>{connect.error}</p>}
    {connect.placement && <p className="muted" data-connect-placement>Joins by default: {connect.placement.join(', ')}</p>}
    <p className="muted">On {connect.host} · asked {when(connect.at)}</p>
    {openState(connect.state) && onCancel && <button data-cancel-connect onClick={() => onCancel(connect.id)}>Cancel</button>}
  </div>;
}

/** One account as the registry sees it: what it runs, which roles it serves, what it is doing, and why it cannot launch when it cannot. */
export function AccountCard({ account, connect, onChangeRoles }: { account: FleetAccountView; connect?: ConnectView; onChangeRoles?: (account: string) => void }) {
  return <div className="criterion" data-account={account.name}>
    <strong className={account.eligible ? undefined : 'amber'}>{account.name} · {account.runtime} · {account.model}{account.modelId ? ` (${account.modelId})` : ''} · {account.eligible ? 'eligible' : 'ineligible'}</strong>
    {account.ineligible && <p role="status" className="amber">Ineligible: {account.ineligible}</p>}
    <p>Roles: {account.roles.length ? account.roles.map(entry => `${entry.role} (${entry.preference} of ${entry.of})`).join(', ') : 'none'} · Live sessions: {account.liveSessions.length ? account.liveSessions.map(session => `${session.role}${session.work ? ` on ${session.work}` : ''} since ${when(session.since)}`).join('; ') : 'none'}{account.maxSessions !== null ? ` (limit ${account.maxSessions})` : ''}{onChangeRoles && <> <button data-change-roles={account.name} onClick={() => onChangeRoles(account.name)}>change</button></>}</p>
    <p>Quota: {account.quota}{account.usage.length ? ` — ${account.usage.map(entry => `${entry.window} ${entry.percent}%`).join(', ')}` : ''} · Resets: {when(account.resetsAt)} · Login: {account.loggedIn === null ? 'not observed' : account.loggedIn ? 'logged in' : 'logged out'} · Observed {when(account.observedAt)}{account.quotaSource === 'operator' ? ' (marked by an operator)' : ''}</p>
    {connect?.placement && <p className="muted">Joined by default: {connect.placement.join(', ')}</p>}
    <p className="muted">Capability: {account.capability?.tier ?? 'unknown'}{account.capability?.contextTokens ? ` · ${account.capability.contextTokens.toLocaleString()} token context` : ''} · {cost(account)} · Credential by reference: {account.home ?? 'the runtime\'s own default login'} on {account.host}{account.enabled ? '' : ' · disabled'}</p>
  </div>;
}

/** A role's launch policy in one line: its flags, its tool allowlist and the model it runs. */
export const policyText = (policy: RolePolicy | undefined) => {
  const parts = [policy?.args.length ? `flags ${policy.args.join(' ')}` : 'no extra flags', policy?.tools.length ? `tools ${policy.tools.join(', ')}` : 'every tool the runtime allows', policy?.model ? `model ${policy.model}` : 'each account\'s own model'];
  return parts.join(' · ');
};

/** The Agents page body, pure over the view so it renders the same in a test as in the browser. */
export function FleetOverview({ fleet, connects = [], onChangeRoles, onCancelConnect }: { fleet: FleetView; connects?: ConnectView[]; onChangeRoles?: (account: string) => void; onCancelConnect?: (id: string) => void }) {
  const running = fleet.sessions.filter(session => !session.endedAt);
  const byName = new Map(connects.filter(connect => connect.name).map(connect => [connect.name!, connect]));
  return <>
    {!fleet.configured && <div className="notice">No role is configured yet, so sessions still launch from each host's local profiles. Connect an account below — or run <code>graphyard master registry propose --apply</code> on a host whose agent CLIs are logged in.</div>}
    {fleet.attention.map(line => <div role="alert" className="notice danger" key={line}>{line}</div>)}
    <section><div className="section-title"><h2>Accounts <span className="count">{fleet.accounts.length}</span></h2></div>
      {connects.map(connect => <ConnectCard key={connect.id} connect={connect} onCancel={onCancelConnect}/>)}
      {fleet.accounts.map(account => <AccountCard key={account.name} account={account} connect={byName.get(account.name)} onChangeRoles={onChangeRoles}/>)}
      {!fleet.accounts.length && !connects.length && <p>No account is connected yet. Connect an account above: pick a provider, paste its key or finish its sign-in — no shell, no configuration files.</p>}
    </section>
    <section><div className="section-title"><h2>Roles <span className="count">{fleet.roles.length}</span></h2></div>
      {fleet.roles.map(role => <div className="criterion" key={role.role} data-role={role.role}><strong className={role.blocked ? 'amber' : undefined}>{role.role} · {role.live} of {role.concurrency} running · next: {role.next ?? 'none'}</strong><p>Preference order: {role.accounts.join(' → ') || 'no account'}</p><p>Launch policy: {policyText(role.policy)}</p>{role.blocked && <p className="amber">{role.blocked}</p>}</div>)}
      {!fleet.roles.length && <p>No role is configured.</p>}
    </section>
    <section><div className="section-title"><h2>Running sessions <span className="count">{running.length}</span></h2></div>
      {running.length > 0 && <table className="flow-data" aria-label="Running sessions by account"><thead><tr><th>Role</th><th>Work</th><th>Account</th><th>Runtime</th><th>Model</th><th>Host</th><th>Since</th></tr></thead>
        <tbody>{[...running].reverse().map(session => <tr key={session.id} data-session={session.id}><td>{session.role}</td><td>{session.work ?? '—'}</td><td>{session.account}</td><td>{session.runtime}</td><td>{session.model}</td><td>{session.host}</td><td>{when(session.selectedAt)}</td></tr>)}</tbody></table>}
      {!running.length && <p>No session launched from the registry is running.</p>}
    </section>
    <section><div className="section-title"><h2>Runtimes <span className="count">{fleet.runtimes.length}</span></h2></div>
      {fleet.runtimes.map(runtime => <div className="criterion" key={runtime.name} data-runtime={runtime.name}><strong>{runtime.name}{runtime.description ? ` · ${runtime.description}` : ''}</strong><p>Launch contract: <code>{[runtime.launch.kind, ...runtime.launch.args].join(' ')}</code> · account home in <code>{runtime.launch.homeVariable ?? 'the default login'}</code> · model flag <code>{runtime.launch.modelFlag ?? 'none'}</code> · tools flag <code>{runtime.launch.toolsFlag ?? 'none'}</code></p>{runtime.launch.login && <p className="muted">Log in with: <code>{runtime.launch.login}</code></p>}</div>)}
      {!fleet.runtimes.length && <p>No runtime is registered.</p>}
    </section>
    <section><div className="section-title"><h2>Recent selections <span className="count">{fleet.sessions.length}</span></h2></div>
      {[...fleet.sessions].reverse().slice(0, 15).map(session => <div className="criterion" key={session.id}><strong>{when(session.selectedAt)} · {session.role} → {session.account}{session.work ? ` · ${session.work}` : ''}{session.endedAt ? ' · ended' : ' · live'}</strong><p>{session.reason}</p>{session.endReason && <p className="muted">Ended: {session.endReason}</p>}</div>)}
      {fleet.refusals.slice(-5).reverse().map(refusal => <div className="criterion" key={`${refusal.at}${refusal.role}`}><strong className="amber">{when(refusal.at)} · {refusal.role}{refusal.work ? ` · ${refusal.work}` : ''} · nothing launched</strong><p>{refusal.reason}</p></div>)}
      {!fleet.sessions.length && !fleet.refusals.length && <p>No session has been selected from the registry yet.</p>}
    </section>
  </>;
}

interface WizardState { open: boolean; provider: string | null; host: string | null; key: string; error: string; busy: string }
const closedWizard: WizardState = { open: false, provider: null, host: null, key: '', error: '', busy: '' };

/** Pick a provider, paste its key (sealed to the host in this browser) or start its login. */
export function ConnectWizard({ providers, hosts, wizard, setWizard, onConnect, onClose }: {
  providers: ConnectProviderView[]; hosts: ConnectHostView[]; wizard: WizardState;
  setWizard: (next: WizardState) => void; onConnect: (provider: string, host: string, key: string) => void; onClose: () => void;
}) {
  const provider = providers.find(entry => entry.id === wizard.provider) ?? null;
  const hostKeys = hosts.find(entry => entry.host === wizard.host)?.publicKey ?? null;
  return <div className="criterion" data-connect-wizard>
    <strong>Connect an account</strong>
    {!provider && <p>Pick the provider of the key or subscription you are connecting. A pasted key is sealed to your agent host in this browser and is never readable by the server.</p>}
    {!provider && <ul className="connect-providers">{providers.map(entry => <li key={entry.id}>
      <button data-pick-provider={entry.id} onClick={() => setWizard({ ...wizard, provider: entry.id, host: wizard.host ?? hosts[0]?.host ?? null, error: '' })}>
        <strong>{entry.label}</strong><br/><small>{entry.help}</small>
      </button></li>)}</ul>}
    {!provider && !hosts.length && <p role="status">No agent host has registered its key yet. Start the executor on your agent host; it registers its key by itself, and this list fills in.</p>}
    {provider && <form className="grant-form" aria-label="Connect the account" onSubmit={event => { event.preventDefault(); onConnect(provider.id, wizard.host ?? hosts[0]?.host ?? '', wizard.key); }}>
      <p>{provider.label} — {provider.kind === 'api-key' ? 'paste the key; it is sealed to the host in this browser before it is sent.' : 'the host starts the provider\'s own login; you finish the sign-in in your own browser.'}</p>
      <label>Agent host<select name="host" value={wizard.host ?? ''} onChange={event => setWizard({ ...wizard, host: event.target.value })}>{hosts.map(entry => <option key={entry.host} value={entry.host}>{entry.host}</option>)}</select></label>
      {provider.kind === 'api-key' && <label>The provider's key<input type="password" name="key" autoComplete="off" value={wizard.key} onChange={event => setWizard({ ...wizard, key: event.target.value })}/></label>}
      {provider.kind === 'api-key' && !hostKeys && <p role="status" className="amber">That host has not registered its key yet; its executor registers it by itself shortly.</p>}
      {wizard.error && <p role="alert" className="amber">{wizard.error}</p>}
      <button disabled={!!wizard.busy || provider.kind === 'api-key' && !hostKeys} data-connect-submit>{wizard.busy || provider.kind === 'api-key' ? 'Connect' : 'Start the login'}</button>
      <button type="button" onClick={onClose}>Close</button>
    </form>}
  </div>;
}

/** Settings › Agents: connect an account without a shell, and every agent the control plane launches (GY-409). */
export default function FleetPage({ api, status }: Pick<Dashboard, 'api' | 'status'>) {
  const [fleet, setFleet] = useState<FleetView | null>(status?.fleet ?? null);
  const [connects, setConnects] = useState<ConnectView[]>(status?.connects ?? []);
  const [providers, setProviders] = useState<ConnectProviderView[]>([]);
  const [hosts, setHosts] = useState<ConnectHostView[]>([]);
  const [wizard, setWizard] = useState<WizardState>(closedWizard);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const advanced = useRef<HTMLDetailsElement>(null);
  const roleAccounts = useRef<HTMLInputElement | null>(null);
  const canEdit = ['admin', 'coordinator'].includes(status?.actor?.role);
  const load = useCallback(async () => {
    const version = ++request.current; setLoadError('');
    try {
      const [next, connect] = await Promise.all([api('agent-registry'), api('agent-registry/connect').catch(() => ({ connects: [] }))]);
      if (version === request.current) { setFleet(next); setConnects(connect.connects ?? []); }
    } catch (error) { if (version === request.current) setLoadError((error as Error).message); }
  }, [api]);
  useEffect(() => { void load(); void api('agent-registry/connect/providers').then(about => setProviders(about.providers ?? [])).catch(() => {}); void api('agent-registry/connect/host-key').then(about => setHosts(about.hosts ?? [])).catch(() => {}); }, [api, load]);
  // An open connect moves on its own (the host's executor works it): poll until nothing is open.
  const open = connects.some(connect => openState(connect.state));
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => { void api('agent-registry/connect').then(about => setConnects(about.connects ?? [])).catch(() => {}); }, 4_000);
    return () => clearInterval(timer);
  }, [api, open]);
  const submit = (path: (form: FormData) => string, body: (form: FormData) => unknown) => async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = event.currentTarget, form = new FormData(target);
    // The registry holds references, never secrets: a pasted credential is refused before it leaves the browser.
    // The audit reason is prose, not launch data, so it may name a token prefix without being refused (GY-397).
    if ([...form.entries()].some(([name, value]) => name !== 'reason' && typeof value === 'string' && value.split(/[\s,]+/).some(looksLikeSecret))) { setFormError('That looks like a credential. The registry stores where a login lives (host and home), never the secret itself; connect the account at the top of this page instead.'); return; }
    setBusy(true); setFormError('');
    try { await api(path(form), body(form)); target.reset(); await load(); }
    catch (error) { setFormError((error as Error).message); }
    finally { setBusy(false); }
  };
  const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
  const optional = (form: FormData, name: string) => field(form, name) || null;
  const amount = (form: FormData, name: string) => field(form, name) ? Number(field(form, name)) : null;
  const list = (form: FormData, name: string, separator: string) => field(form, name).split(separator).map(entry => entry.trim()).filter(Boolean);
  const connect = async (providerId: string, host: string, key: string) => {
    const provider = providers.find(entry => entry.id === providerId);
    if (!provider) return;
    setWizard({ ...wizard, busy: 'connecting', error: '' });
    try {
      let sealed: { ephemeral: string; iv: string; ciphertext: string } | undefined;
      if (provider.kind === 'api-key') {
        const registered = hosts.find(entry => entry.host === host)?.publicKey;
        if (!registered) throw new Error(`The host ${host} has not registered its key yet; its executor registers it by itself shortly.`);
        // Sealed here, in the browser: the server stores and relays ciphertext only.
        sealed = await sealForHost(registered, key);
      }
      await api('agent-registry/connect', { host, provider: providerId, ...(sealed ? { sealed } : {}), reason: `Connect ${provider.label} from Settings › Agents` });
      setWizard(closedWizard);
      await load();
    } catch (error) { setWizard(current => ({ ...current, busy: '', error: (error as Error).message })); }
  };
  const cancel = async (id: string) => { try { await api(`agent-registry/connect/${id}/cancel`, { reason: 'Cancelled from Settings › Agents' }); await load(); } catch (error) { setFormError((error as Error).message); } };
  /** The card's 'change': open Advanced and name the account in the role editor's order. */
  const changeRoles = (account: string) => {
    if (advanced.current) advanced.current.open = true;
    const input = roleAccounts.current;
    if (input) { const names = input.value.split(',').map(entry => entry.trim()).filter(Boolean); if (!names.includes(account)) input.value = [...names, account].join(', '); }
    document.getElementById('role-editor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  return <><header><div className="breadcrumb">Settings <span>/</span> Agents</div><a href="/docs/onboarding#connect-an-account">Read the guide ↗</a></header>
    <div className="page-heading"><div><div className="eyebrow">EVERY AGENT IS CONFIGURED HERE</div><h1>Agents</h1><p>Connect an account below — pick a provider, paste its key or finish its sign-in, and the host does the rest. A pasted key is sealed to your agent host in this browser: the server stores and relays ciphertext only, the key is written only on the host, in the provider's own file, and a one-line smoke test decides when the card turns healthy. Every launch picks the first eligible account of its role; a change here takes effect on the next action, with no restart and no file edit.</p></div></div>
    {loadError && <div role="alert" className="notice danger">{loadError} <button onClick={() => void load()}>Retry loading the agents</button></div>}
    {!fleet && !loadError && <p role="status">Loading the agents…</p>}
    {fleet && canEdit && <section><div className="section-title"><h2>Connect an account</h2>{!wizard.open && <button className="connect-button" data-connect-account onClick={() => setWizard({ ...closedWizard, open: true, host: hosts[0]?.host ?? null })}>Connect an account</button>}</div>
      {wizard.open && <ConnectWizard providers={providers} hosts={hosts} wizard={wizard} setWizard={setWizard} onConnect={id => void connect(id, wizard.host ?? hosts[0]?.host ?? '', wizard.key)} onClose={() => setWizard(closedWizard)}/>}
    </section>}
    {fleet && <FleetOverview fleet={fleet} connects={connects} onChangeRoles={canEdit ? changeRoles : undefined} onCancelConnect={canEdit ? id => void cancel(id) : undefined}/>}
    {fleet && canEdit && <section><details className="advanced more-details" ref={advanced}><summary>Advanced: runtimes, models, roles and policies</summary>
      <p className="muted">Everything below names where a login lives — never the credential. Connect accounts at the top of the page; use this only to shape the fleet itself. Every change is recorded with its reason.</p>
      {formError && <p role="alert" className="amber">{formError}</p>}
      <form className="grant-form" aria-label="Add or change a runtime" onSubmit={submit(() => 'agent-registry/runtimes', form => ({ runtime: { name: field(form, 'name'), launch: { kind: field(form, 'kind') || field(form, 'name'), args: field(form, 'args').split(/\s+/).filter(Boolean), homeVariable: optional(form, 'homeVariable'), modelFlag: optional(form, 'modelFlag'), toolsFlag: optional(form, 'toolsFlag'), login: optional(form, 'login'), loginFile: optional(form, 'loginFile') } }, reason: field(form, 'reason') }))}>
        <label>Runtime<input name="name" required placeholder="muse"/></label>
        <label>Executable / Herdr kind<input name="kind" placeholder="muse"/></label>
        <label>Startup arguments<input name="args" placeholder="--approval-mode never --trust-workspace"/></label>
        <label>Account home variable<input name="homeVariable" placeholder="CLAUDE_CONFIG_DIR"/></label>
        <label>Model flag<input name="modelFlag" placeholder="--model"/></label>
        <label>Tools flag<input name="toolsFlag" placeholder="--allowedTools"/></label>
        <label>Login command<input name="login" placeholder="muse login"/></label>
        <label>Login file in the home<input name="loginFile" placeholder="auth.json"/></label>
        <label>Audit reason<input name="reason" required placeholder="Adding the Muse runtime"/></label>
        <button disabled={busy}>Save runtime</button>
      </form>
      <form className="grant-form" aria-label="Add or change a model" onSubmit={submit(() => 'agent-registry/models', form => ({ model: { name: field(form, 'name'), id: optional(form, 'id'), ...(field(form, 'provider') ? { provider: field(form, 'provider') } : {}), cost: { inputPerMTok: amount(form, 'input'), outputPerMTok: amount(form, 'output') }, capability: { tier: field(form, 'tier') || 'strong', contextTokens: amount(form, 'context') } }, reason: field(form, 'reason') }))}>
        <label>Model<input name="name" required placeholder="opus"/></label>
        <label>Identifier passed to the runtime<input name="id" placeholder="claude-opus-5"/></label>
        <label>Provider<input name="provider" placeholder="Anthropic"/></label>
        <label>Input cost (USD per MTok)<input name="input" type="number" min="0" step="any"/></label>
        <label>Output cost (USD per MTok)<input name="output" type="number" min="0" step="any"/></label>
        <label>Capability<select name="tier" defaultValue="strong">{capabilityTiers.map(tier => <option key={tier}>{tier}</option>)}</select></label>
        <label>Context tokens<input name="context" type="number" min="1000" step="1"/></label>
        <label>Audit reason<input name="reason" required placeholder="Recording the model and its price"/></label>
        <button disabled={busy}>Save model</button>
      </form>
      <form className="grant-form" aria-label="Add or change an account" onSubmit={submit(() => 'agent-registry/accounts', form => ({ account: { name: field(form, 'name'), runtime: field(form, 'runtime'), model: field(form, 'model'), credential: { host: field(form, 'host'), home: optional(form, 'home'), ...(optional(form, 'keyFile') ? { key: { file: field(form, 'keyFile'), variable: field(form, 'keyVariable') } } : {}) }, maxSessions: amount(form, 'maxSessions') }, reason: field(form, 'reason') }))}>
        <label>Account<input name="name" required placeholder="claude-b"/></label>
        <label>Runtime<select name="runtime" required>{fleet.runtimes.map(runtime => <option key={runtime.name}>{runtime.name}</option>)}</select></label>
        <label>Model<select name="model" required>{fleet.models.map(model => <option key={model.name}>{model.name}</option>)}</select></label>
        <label>Host that holds the login<input name="host" required defaultValue={fleet.accounts[0]?.host ?? ''} placeholder="build-host-1"/></label>
        <label>Login home on that host<input name="home" placeholder="/home/agent/.coding_agents/claude-b"/></label>
        <label>API key file in that home (a name, never the key)<input name="keyFile" placeholder="zai.key"/></label>
        <label>Variable the runtime reads the key from<input name="keyVariable" placeholder="ZAI_API_KEY"/></label>
        <label>Session limit<input name="maxSessions" type="number" min="1" step="1"/></label>
        <label>Audit reason<input name="reason" required placeholder="Second Claude subscription"/></label>
        <button disabled={busy}>Save account</button>
      </form>
      <form className="grant-form" id="role-editor" aria-label="Set a role" onSubmit={submit(() => 'agent-registry/roles', form => ({ role: { name: field(form, 'name'), accounts: list(form, 'accounts', ','), concurrency: Number(field(form, 'concurrency')),
        policy: { args: field(form, 'args').split(/\s+/).filter(Boolean), tools: list(form, 'tools', ','), model: optional(form, 'model') } }, reason: field(form, 'reason') }))}>
        <label>Role<select name="name" required>{fleetRoles.map(role => <option key={role}>{role}</option>)}</select></label>
        <label>Accounts, most preferred first<input ref={roleAccounts} name="accounts" required placeholder="claude-b, claude-c, codex-a"/></label>
        <label>Concurrency limit<input name="concurrency" type="number" min="0" max="100" step="1" required defaultValue={2}/></label>
        <label>Permission and approval flags<input name="args" placeholder="--permission-mode bypassPermissions"/></label>
        <label>Allowed tools<input name="tools" placeholder="Read, Grep, Bash(git:*)"/></label>
        <label>Model for this role<select name="model" defaultValue=""><option value="">each account's own</option>{fleet.models.map(model => <option key={model.name}>{model.name}</option>)}</select></label>
        <label>Audit reason<input name="reason" required placeholder="Prefer the cheaper account for reviews"/></label>
        <button disabled={busy}>Save role</button>
      </form>
      <form className="grant-form" aria-label="Mark an account's quota" onSubmit={submit(form => `agent-registry/accounts/${encodeURIComponent(field(form, 'name'))}/quota`, form => ({ quota: { state: field(form, 'state'), resetsAt: field(form, 'resetsAt') ? new Date(field(form, 'resetsAt')).toISOString() : null }, reason: field(form, 'reason') }))}>
        <label>Account<select name="name" required>{fleet.accounts.map(account => <option key={account.name}>{account.name}</option>)}</select></label>
        <label>Quota<select name="state" defaultValue="exhausted">{quotaStates.map(state => <option key={state}>{state}</option>)}</select></label>
        <label>Resets at<input name="resetsAt" type="datetime-local"/></label>
        <label>Audit reason<input name="reason" required placeholder="Plan exhausted until Monday"/></label>
        <button disabled={busy}>Mark quota</button>
      </form>
      <form className="grant-form" aria-label="Remove an entry" onSubmit={submit(form => `agent-registry/${field(form, 'collection')}/${encodeURIComponent(field(form, 'name'))}/remove`, form => ({ reason: field(form, 'reason') }))}>
        <label>Remove<select name="collection" defaultValue="accounts"><option value="accounts">account</option><option value="runtimes">runtime (and its accounts)</option><option value="models">model</option><option value="roles">role</option></select></label>
        <label>Name<input name="name" required placeholder="claude-b"/></label>
        <label>Audit reason<input name="reason" required placeholder="Subscription cancelled"/></label>
        <button disabled={busy}>Remove</button>
      </form>
    </details></section>}
  </>;
}
