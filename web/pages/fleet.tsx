import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { capabilityTiers, fleetRoles, groupAccountsByPlan, looksLikeSecret, quotaStates, type FleetAccountView, type FleetView, type RolePolicy } from '../../src/model/registry';
import { formatAge } from '../../src/model/duration';
import { sealForHost } from '../seal';
import type { Dashboard } from './dashboard';
import { accountStatus, chipTones, countdown, localTime, roleLaunch, type AccountStatus } from '../agent-status';
import { MoreDetails, PageHeader, PageSection } from '../components/page-layout';

const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—';
const cost = (account: FleetAccountView) => account.cost && (account.cost.inputPerMTok !== null || account.cost.outputPerMTok !== null)
  ? `$${account.cost.inputPerMTok ?? '?'} in / $${account.cost.outputPerMTok ?? '?'} out per MTok` : 'cost not recorded';

/** A connect an operator made from this page, as the control plane reports it. */
export interface ConnectView {
  id: string; at: string; updatedAt: string; host: string; provider: string;
  state: 'pending' | 'claimed' | 'connecting' | 'waiting-login' | 'healthy' | 'failed' | 'cancelled';
  name: string | null; home: string | null; url: string | null; code: string | null;
  /** The login waits for the code its sign-in page shows (Claude Code), and whether it was sent. */
  awaitingCode?: boolean; answered?: boolean;
  error: string | null; detail: string | null; placement: string[] | null; worker: string | null;
}
export interface ConnectProviderView { id: string; label: string; kind: 'api-key' | 'subscription'; tier: string; help: string }
export interface ConnectHostView { host: string; publicKey?: string; registeredAt: string }

const openState = (state: ConnectView['state']) => state === 'pending' || state === 'claimed' || state === 'connecting' || state === 'waiting-login';
const stateText = (connect: ConnectView) => connect.state === 'waiting-login' ? 'Waiting for you to finish the sign-in'
  : openState(connect.state) ? 'Connecting…'
  : connect.state === 'healthy' ? 'Connected' : connect.state === 'failed' ? 'Failed' : 'Cancelled';

/**
 * The code a sign-in page shows, pasted back on the card: asked for only once the operator says
 * they have it, so the default view carries no field (GY-409 AC-1).
 */
function SignInCode({ connect, onAnswer }: { connect: ConnectView; onAnswer: (id: string, code: string) => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (connect.answered) return <p className="muted" data-connect-answered>Code sent; the host is finishing the sign-in.</p>;
  if (!asking) return <p>After signing in, the page shows a code. <button data-paste-code={connect.id} onClick={() => setAsking(true)}>Paste the code</button></p>;
  return <form className="grant-form" aria-label="Send the sign-in code" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError('');
    onAnswer(connect.id, code).then(() => setCode(''), failure => setError((failure as Error).message)).finally(() => setBusy(false));
  }}>
    <label>The code the sign-in page shows<input type="password" name="code" autoComplete="off" required value={code} onChange={event => setCode(event.target.value)}/></label>
    {error && <p role="alert" className="amber">{error}</p>}
    <button disabled={busy || !code.trim()} data-send-code>Send the code</button>
  </form>;
}

/** One connect in flight or finished: what the provider's login printed, and why it failed when it did. */
export function ConnectCard({ connect, onCancel, onAnswer, onRetry, onRemove }: { connect: ConnectView; onCancel?: (id: string) => void; onAnswer?: (id: string, code: string) => Promise<void>; onRetry?: (connect: ConnectView) => void; onRemove?: (id: string) => void }) {
  return <div className="criterion" data-connect={connect.id} data-provider={connect.provider}>
    <strong className={connect.state === 'failed' ? 'amber' : undefined}>{connect.provider} · {stateText(connect)}{connect.name ? ` · ${connect.name}` : ''}</strong>
    {(connect.url || connect.code) && <p data-connect-login={connect.state}>{connect.state === 'waiting-login' ? 'Finish the sign-in in your own browser:' : 'Signed in'}{connect.url ? <> <a href={connect.url} rel="noreferrer">{connect.url}</a></> : null}{connect.url && connect.code ? ' · code ' : connect.code ? ' code ' : null}{connect.code ? <code data-connect-code>{connect.code}</code> : null}</p>}
    {connect.state === 'waiting-login' && connect.awaitingCode && onAnswer && <SignInCode connect={connect} onAnswer={onAnswer}/>}
    {connect.state === 'failed' && connect.error && <p role="alert" className="amber" data-connect-error>{connect.error}</p>}
    {connect.placement && <p className="muted" data-connect-placement>Joins by default: {connect.placement.join(', ')}</p>}
    <p className="muted">On {connect.host} · asked {when(connect.at)}</p>
    {openState(connect.state) && onCancel && <button data-cancel-connect onClick={() => onCancel(connect.id)}>Cancel</button>}
    {connect.state === 'failed' && onRetry && <button data-retry-connect title="Connect this provider again on this host" onClick={() => onRetry(connect)}>Retry</button>}
    {connect.state === 'failed' && onRemove && <button data-remove-connect title="Take this card off this page; the record stays in the ledger" onClick={() => onRemove(connect.id)}>Remove</button>}
  </div>;
}

/** One account as the registry sees it: what it runs, which roles it serves, what it is doing, and why it cannot launch when it cannot. */
// Whether a form carries a secret-shaped value in its launch data. The audit reason is prose, not launch data,
// so it may name a token prefix without being refused (GY-397).
export const pastesCredential = (form: FormData) => [...form.entries()].some(([name, value]) => name !== 'reason' && typeof value === 'string' && value.split(/[\s,]+/).some(looksLikeSecret));

/**
 * How old an account's quota reading may be before the fleet panel calls it an old probe
 * (GY-945): executors fold what they observe into the registry on every action, so on a working
 * fleet a reading is minutes old, and one that has stood for over an hour says nothing about a
 * wall the provider may have lifted since. The one freshness bound every reader applies;
 * docs/dashboard.md states it.
 */
export const quotaStaleThresholdMs = 60 * 60_000;

/**
 * An account's probe health, for the fleet panel (GY-945): `failed` when its last smoke test
 * failed (the probe that proves the account works failed it), `stale` when its quota was never
 * observed or was observed longer than `quotaStaleThresholdMs` ago — an old reading, however
 * alarming it reads — and `fresh` otherwise. `text` is what the card shows beside the observation
 * time; every tone draws its own class, so an operator can tell a real wall from an old probe.
 */
export function probeStatus(account: Pick<FleetAccountView, 'observedAt' | 'smoke' | 'quotaSource'>, now: number): { tone: 'fresh' | 'stale' | 'failed'; text: string } {
  if (account.smoke?.result === 'fail') return { tone: 'failed', text: `probe failed${account.smoke.reason ? `: ${account.smoke.reason}` : ''}` };
  const verb = account.quotaSource === 'operator' ? 'marked' : 'observed';
  if (account.observedAt === null || !Number.isFinite(Date.parse(account.observedAt))) return { tone: 'stale', text: `quota never ${verb}` };
  const age = formatAge(account.observedAt, now);
  return Date.parse(account.observedAt) < now - quotaStaleThresholdMs
    ? { tone: 'stale', text: `old probe — quota ${verb} ${age} ago` }
    : { tone: 'fresh', text: `quota ${verb} ${age} ago` };
}

/** A usage window's reading with the reset the registry carries for it, when it carries one. */
export const usageText = (usage: FleetAccountView['usage']) => usage.map(entry => `${entry.window} ${entry.percent}%${entry.resetsAt ? ` (resets ${when(entry.resetsAt)})` : ''}`).join(', ');

export function AccountCard({ account, connect, onChangeRoles, now = Date.now() }: { account: FleetAccountView; connect?: ConnectView; onChangeRoles?: (account: string) => void; now?: number }) {
  const probe = probeStatus(account, now);
  const live = account.liveSessions.length;
  return <div className="criterion" data-account={account.name} data-probe={probe.tone}>
    <strong className={account.eligible ? undefined : 'amber'}>{account.name} · {account.runtime} · {account.model}{account.modelId ? ` (${account.modelId})` : ''}{account.plan ? ` · ${account.plan}` : ''}{ connect?.provider ? ` · ${connect.provider}` : '' } · {account.eligible ? 'eligible' : 'ineligible'}</strong>
    {account.ineligible && <p role="status" className="amber">Ineligible: {account.ineligible}</p>}
    <p>Roles: {account.roles.length ? account.roles.map(entry => `${entry.role} (${entry.preference} of ${entry.of})`).join(', ') : 'none'} · Live sessions: {live}{live ? ` — ${account.liveSessions.map(session => `${session.role}${session.work ? ` on ${session.work}` : ''} since ${when(session.since)}`).join('; ')}` : ''}{account.maxSessions !== null ? ` (limit ${account.maxSessions})` : ''}{onChangeRoles && <> <button data-change-roles={account.name} onClick={() => onChangeRoles(account.name)}>change</button></>}</p>
    <p>Quota: {account.quota}{account.usage.length ? ` — ${usageText(account.usage)}` : ''} · Resets: {when(account.resetsAt)} · Login: {account.loggedIn === null ? 'not observed' : account.loggedIn ? 'logged in' : 'logged out'} · Observed {when(account.observedAt)}{account.quotaSource === 'operator' ? ' (marked by an operator)' : ''} <span className={`probe ${probe.tone}`} data-probe={probe.tone}>{probe.text}</span></p>
    {connect?.placement && <p className="muted">Joined by default: {connect.placement.join(', ')}</p>}
    <p className="muted">Capability: {account.capability?.tier ?? 'unknown'}{account.capability?.contextTokens ? ` · ${account.capability.contextTokens.toLocaleString()} token context` : ''} · {cost(account)} · Credential by reference: {account.home ?? 'the runtime\'s own default login'} on {account.host}{account.enabled ? '' : ' · disabled'}</p>
  </div>;
}

/** A role's launch policy in one line: its flags, its tool allowlist and the model it runs. */
export const policyText = (policy: RolePolicy | undefined) => {
  const parts = [policy?.args.length ? `flags ${policy.args.join(' ')}` : 'no extra flags', policy?.tools.length ? `tools ${policy.tools.join(', ')}` : 'every tool the runtime allows', policy?.model ? `model ${policy.model}` : 'each account\'s own model'];
  return parts.join(' · ');
};

/** One account's status chip: its label, drawn in its tone, with the reason as its title. */
export const StatusChip = ({ status }: { status: AccountStatus }) =>
  <span className={`status-chip tone-${chipTones[status.chip]}`} data-chip={status.chip}>{status.label}</span>;

/** Every registry account in one table, grouped under its provider plan with usage bars per window (GY-1121). */
export function AccountsTable({ fleet, now }: { fleet: FleetView; now: number }) {
  const plans = fleet.plans && fleet.plans.length > 0
    ? fleet.plans
    : groupAccountsByPlan({ accounts: fleet.accounts }, now);
  const seen = new Set<string>();

  return <table className="flow-data agents-table" aria-label="Accounts at a glance"><thead><tr><th>Account</th><th>Status</th><th>Why</th><th>Back</th><th>Roles</th><th>Runs</th></tr></thead>
    {plans.map(plan => <tbody key={plan.id || plan.name} data-plan-group={plan.name}>
      <tr className="plan-header-row" data-plan={plan.name}>
        <th colSpan={6} className="plan-header">
          <div className="plan-header-content">
            <span className="plan-name" data-plan-name={plan.name}>{plan.name}</span>
            <div className="plan-usage" data-plan-usage={plan.name}>
              {plan.usage.reported && plan.usage.windows.length > 0 ? (
                plan.usage.windows.map(win => (
                  <div
                    key={win.window}
                    className="usage-bar-container"
                    data-window={win.window}
                    title={`${win.window}: ${win.percent}% used${win.resetsAt ? `, resets ${when(win.resetsAt)}` : ''}`}
                  >
                    <span className="usage-window-label">{win.window}</span>
                    <div className="usage-bar-track" role="progressbar" aria-valuenow={win.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${win.window} usage`}>
                      <div
                        className={`usage-bar-fill ${win.percent >= 90 ? 'danger' : win.percent >= 75 ? 'warn' : 'ok'}`}
                        style={{ width: `${Math.min(100, Math.max(0, win.percent))}%` }}
                      />
                    </div>
                    <span className="usage-window-stats">
                      {win.percent}% used{win.resetsAt ? ` · resets ${countdown(win.resetsAt, now)}` : ''}
                    </span>
                  </div>
                ))
              ) : (
                <span className="usage-not-reported" data-not-reported>
                  {plan.usage.reason || `usage not reported by ${plan.name}`}
                </span>
              )}
            </div>
          </div>
        </th>
      </tr>
      {plan.accounts.map(accountName => {
        seen.add(accountName);
        const account = fleet.accounts.find(entry => entry.name === accountName);
        if (!account) return null;
        const status = accountStatus(account, fleet, now);
        return <tr key={account.name} data-account-row={account.name} data-status={status.chip}>
          <th scope="row">{account.name}</th>
          <td data-label="Status"><StatusChip status={status}/></td>
          <td data-label="Why" className="why">{status.reason}</td>
          <td data-label="Back">{status.until ? <time dateTime={status.until} title={status.until}>{localTime(status.until)} <small>{countdown(status.until, now)}</small></time> : '—'}</td>
          <td data-label="Roles">{account.roles.map(entry => entry.role).join(', ') || '—'}</td>
          <td data-label="Runs">{account.runtime} · {account.model}</td>
        </tr>;
      })}
    </tbody>)}
    {fleet.accounts.filter(a => !seen.has(a.name)).length > 0 && <tbody>
      {fleet.accounts.filter(a => !seen.has(a.name)).map(account => {
        const status = accountStatus(account, fleet, now);
        return <tr key={account.name} data-account-row={account.name} data-status={status.chip}>
          <th scope="row">{account.name}</th>
          <td data-label="Status"><StatusChip status={status}/></td>
          <td data-label="Why" className="why">{status.reason}</td>
          <td data-label="Back">{status.until ? <time dateTime={status.until} title={status.until}>{localTime(status.until)} <small>{countdown(status.until, now)}</small></time> : '—'}</td>
          <td data-label="Roles">{account.roles.map(entry => entry.role).join(', ') || '—'}</td>
          <td data-label="Runs">{account.runtime} · {account.model}</td>
        </tr>;
      })}
    </tbody>}
  </table>;
}

/** Per role: can it launch now, and when it cannot, why and the earliest time it can (GY-978 AC-2). */
export function RoleLaunches({ fleet, now }: { fleet: FleetView; now: number }) {
  return <ul className="role-launches">{fleet.roles.map(role => { const launch = roleLaunch(role, fleet, now); return <li key={role.role} data-role-launch={role.role} data-can-launch={launch.canLaunch ? 'yes' : 'no'}>
    <span className={`status-chip tone-${launch.canLaunch ? 'ok' : 'bad'}`}>{launch.canLaunch ? 'Can launch' : 'Cannot launch'}</span> {launch.text}</li>; })}</ul>;
}

/** The Agents page body, pure over the view so it renders the same in a test as in the browser. `now` pins the clock (tests); the page passes the dashboard's server snapshot clock (GY-952). */
export function FleetOverview({ fleet, connects = [], now = Date.now(), onChangeRoles, onCancelConnect, onAnswerConnect, onRetryConnect, onRemoveConnect }: { fleet: FleetView; connects?: ConnectView[]; now?: number; onChangeRoles?: (account: string) => void; onCancelConnect?: (id: string) => void; onAnswerConnect?: (id: string, code: string) => Promise<void>; onRetryConnect?: (connect: ConnectView) => void; onRemoveConnect?: (id: string) => void }) {
  const running = fleet.sessions.filter(session => !session.endedAt);
  const byName = new Map(connects.filter(connect => connect.name).map(connect => [connect.name!, connect]));
  return <>
    {!fleet.configured && <div className="notice">No role is configured yet, so sessions still launch from each host's local profiles. Connect an account below — or run <code>graphyard master registry propose --apply</code> on a host whose agent CLIs are logged in.</div>}
    {/* A blocked role reads in its launch line and a role-less account in its chip; only a role missing from the registry has no other place. */}
    {(() => { const missing = fleet.attention.flatMap(line => /^role (\S+) is not configured/.exec(line)?.[1] ?? []);
      return missing.length > 0 && <div role="alert" className="notice danger">Not configured: {missing.join(', ')} — {missing.length > 1 ? 'their' : 'its'} sessions launch from local profiles until {missing.length > 1 ? 'they are' : 'it is'}.</div>; })()}
    {fleet.roles.length > 0 && <PageSection title="Can launch now?" count={`${fleet.roles.filter(role => roleLaunch(role, fleet, now).canLaunch).length} of ${fleet.roles.length}`}><RoleLaunches fleet={fleet} now={now}/></PageSection>}
    <PageSection title="Accounts" count={fleet.accounts.length}>
      {connects.map(connect => <ConnectCard key={connect.id} connect={connect} onCancel={onCancelConnect} onAnswer={onAnswerConnect} onRetry={onRetryConnect} onRemove={onRemoveConnect}/>)}
      {fleet.accounts.length > 0 && <AccountsTable fleet={fleet} now={now}/>}
      {!fleet.accounts.length && !connects.length && <p>No account is connected yet. Connect an account above: pick a provider, paste its key or finish its sign-in — no shell, no configuration files.</p>}
      {fleet.accounts.length > 0 && <MoreDetails summary="Account details: login, usage windows, probe, capability and credential home">
        {fleet.accounts.map(account => <AccountCard key={account.name} account={account} connect={byName.get(account.name)} onChangeRoles={onChangeRoles} now={now}/>)}
      </MoreDetails>}
    </PageSection>
    <PageSection title="Running sessions" count={running.length}>
      {running.length > 0 && <table className="flow-data" aria-label="Running sessions by account"><thead><tr><th>Role</th><th>Work</th><th>Account</th><th>Runtime</th><th>Model</th><th>Host</th><th>Since</th></tr></thead>
        <tbody>{[...running].reverse().map(session => <tr key={session.id} data-session={session.id}><td>{session.role}</td><td>{session.work ?? '—'}</td><td>{session.account}</td><td>{session.runtime}</td><td>{session.model}</td><td>{session.host}</td><td>{when(session.selectedAt)}</td></tr>)}</tbody></table>}
      {!running.length && <p>No session launched from the registry is running.</p>}
    </PageSection>
    <PageSection title="Roles" count={fleet.roles.length}>
      {fleet.roles.map(role => <div className="criterion" key={role.role} data-role={role.role}><strong className={role.blocked ? 'amber' : undefined}>{role.role} · {role.live} of {role.concurrency} running · next: {role.next ?? 'none'}</strong><p>Preference order: {role.accounts.join(' → ') || 'no account'}</p><p>Launch policy: {policyText(role.policy)}</p>{role.blocked && <p className="amber">{role.blocked}</p>}</div>)}
      {!fleet.roles.length && <p>No role is configured.</p>}
    </PageSection>
    <MoreDetails summary={`Runtimes (${fleet.runtimes.length}) and recent selections (${fleet.sessions.length})`}>
      <PageSection title="Runtimes" count={fleet.runtimes.length}>
        {fleet.runtimes.map(runtime => <div className="criterion" key={runtime.name} data-runtime={runtime.name}><strong>{runtime.name}{runtime.description ? ` · ${runtime.description}` : ''}</strong><p>Launch contract: <code>{[runtime.launch.kind, ...runtime.launch.args].join(' ')}</code> · account home in <code>{runtime.launch.homeVariable ?? 'the default login'}</code> · model flag <code>{runtime.launch.modelFlag ?? 'none'}</code> · tools flag <code>{runtime.launch.toolsFlag ?? 'none'}</code></p>{runtime.launch.login && <p className="muted">Log in with: <code>{runtime.launch.login}</code></p>}</div>)}
        {!fleet.runtimes.length && <p>No runtime is registered.</p>}
      </PageSection>
      <PageSection title="Recent selections" count={fleet.sessions.length}>
        {[...fleet.sessions].reverse().slice(0, 15).map(session => <div className="criterion" key={session.id}><strong>{when(session.selectedAt)} · {session.role} → {session.account}{session.work ? ` · ${session.work}` : ''}{session.endedAt ? ' · ended' : ' · live'}</strong><p>{session.reason}</p>{session.endReason && <p className="muted">Ended: {session.endReason}</p>}</div>)}
        {fleet.refusals.slice(-5).reverse().map(refusal => <div className="criterion" key={`${refusal.at}${refusal.role}`}><strong className="amber">{when(refusal.at)} · {refusal.role}{refusal.work ? ` · ${refusal.work}` : ''} · nothing launched</strong><p>{refusal.reason}</p></div>)}
        {!fleet.sessions.length && !fleet.refusals.length && <p>No session has been selected from the registry yet.</p>}
      </PageSection>
    </MoreDetails>
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
export default function FleetPage({ api, status, observedAt }: Pick<Dashboard, 'api' | 'status' | 'observedAt'>) {
  const [fleet, setFleet] = useState<FleetView | null>(status?.fleet ?? null);
  const [connects, setConnects] = useState<ConnectView[]>(status?.connects ?? []);
  const [providers, setProviders] = useState<ConnectProviderView[]>([]);
  const [hosts, setHosts] = useState<ConnectHostView[]>([]);
  const [wizard, setWizard] = useState<WizardState>(closedWizard);
  // A removed failed connect comes off this page for this browser (the ledger keeps the record):
  // the control plane holds no removal action for a finished connect, so the page keeps the ids here.
  const [removed, setRemoved] = useState<string[]>(() => { try { return JSON.parse(typeof localStorage === 'undefined' ? '[]' : localStorage.getItem('graphyard.removedConnects') ?? '[]') as string[]; } catch { return []; } });
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const advanced = useRef<HTMLDetailsElement>(null);
  const roleAccounts = useRef<HTMLInputElement | null>(null);
  const canEdit = ['admin', 'coordinator'].includes(status?.actor?.role);
  // Probe freshness reads the dashboard's server snapshot clock, not this workstation's (GY-952):
  // registry timestamps come from the control plane's database, so a browser clock skewed past the
  // one-hour threshold would label a fresh observation old or keep a stale one fresh.
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
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
    if (pastesCredential(form)) { setFormError('That looks like a credential. The registry stores where a login lives (host and home), never the secret itself; connect the account at the top of this page instead.'); return; }
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
  /** The sign-in code goes the way a pasted key does: sealed to the connect's host in this browser. */
  const answer = async (id: string, code: string) => {
    const host = connects.find(entry => entry.id === id)?.host;
    let registered = hosts.find(entry => entry.host === host)?.publicKey;
    if (!registered) registered = ((await api('agent-registry/connect/host-key')).hosts as ConnectHostView[] ?? []).find(entry => entry.host === host)?.publicKey;
    if (!registered) throw new Error(`The host ${host} has not registered its key yet; its executor registers it by itself shortly.`);
    await api(`agent-registry/connect/${id}/answer`, { sealed: await sealForHost(registered, code.trim()) });
    await load();
  };
  const cancel = async (id: string) => { try { await api(`agent-registry/connect/${id}/cancel`, { reason: 'Cancelled from Settings › Agents' }); await load(); } catch (error) { setFormError((error as Error).message); } };
  /** Take a failed connect's card off this page for this browser; the ledger record is untouched. */
  const remove = (id: string) => setRemoved(current => { const next = [...new Set([...current, id])]; try { localStorage.setItem('graphyard.removedConnects', JSON.stringify(next)); } catch { /* a private window keeps it for the session */ } return next; });
  /** Retry reconnects the same provider on the same host: an api key is sealed again (it was never stored), a subscription login starts afresh. Admins only, like answering the login code: retrying re-enters the credential; coordinators keep inspect, cancel and remove. */
  const retry = (failed: ConnectView) => setWizard({ ...closedWizard, open: true, provider: failed.provider, host: failed.host });
  /** The card's 'change': open Advanced and name the account in the role editor's order. */
  const changeRoles = (account: string) => {
    if (advanced.current) advanced.current.open = true;
    const input = roleAccounts.current;
    if (input) { const names = input.value.split(',').map(entry => entry.trim()).filter(Boolean); if (!names.includes(account)) input.value = [...names, account].join(', '); }
    document.getElementById('role-editor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  return <><PageHeader crumbs={['Settings', 'Agents']} guide="/docs/onboarding#connect-an-account" eyebrow="EVERY AGENT IS CONFIGURED HERE" title="Agents">
      Which agents can work right now, which are spent and until when, and why. Every launch picks the first eligible account of its role; a change here takes effect on the next action, with no restart and no file edit. A pasted key is sealed to your agent host in this browser and never readable by the server.
    </PageHeader>
    {loadError && <div role="alert" className="notice danger">{loadError} <button onClick={() => void load()}>Retry loading the agents</button></div>}
    {!fleet && !loadError && <p role="status">Loading the agents…</p>}
    {fleet && canEdit && <PageSection title="Connect an account" actions={!wizard.open && <button className="connect-button" data-connect-account onClick={() => setWizard({ ...closedWizard, open: true, host: hosts[0]?.host ?? null })}>Connect an account</button>}>
      {wizard.open && <ConnectWizard providers={providers} hosts={hosts} wizard={wizard} setWizard={setWizard} onConnect={id => void connect(id, wizard.host ?? hosts[0]?.host ?? '', wizard.key)} onClose={() => setWizard(closedWizard)}/>}
    </PageSection>}
    {fleet && <FleetOverview fleet={fleet} connects={connects.filter(connect => !removed.includes(connect.id))} now={now} onChangeRoles={canEdit ? changeRoles : undefined} onCancelConnect={canEdit ? id => void cancel(id) : undefined} onAnswerConnect={status?.actor?.role === 'admin' ? answer : undefined} onRetryConnect={status?.actor?.role === 'admin' ? retry : undefined} onRemoveConnect={canEdit ? remove : undefined}/>}
    {fleet && canEdit && <section><MoreDetails className="advanced" detailsRef={advanced} summary="Advanced: runtimes, models, roles and policies">
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
      <form className="grant-form" aria-label="Add or change an account" onSubmit={submit(() => 'agent-registry/accounts', form => ({ account: { name: field(form, 'name'), runtime: field(form, 'runtime'), model: field(form, 'model'), plan: optional(form, 'plan'), credential: { host: field(form, 'host'), home: optional(form, 'home'), ...(optional(form, 'keyFile') ? { key: { file: field(form, 'keyFile'), variable: field(form, 'keyVariable') } } : {}) }, maxSessions: amount(form, 'maxSessions') }, reason: field(form, 'reason') }))}>
        <label>Account<input name="name" required placeholder="claude-b"/></label>
        <label>Runtime<select name="runtime" required>{fleet.runtimes.map(runtime => <option key={runtime.name}>{runtime.name}</option>)}</select></label>
        <label>Model<select name="model" required>{fleet.models.map(model => <option key={model.name}>{model.name}</option>)}</select></label>
        <label>Provider plan (optional)<input name="plan" placeholder="Claude, Codex, Z.AI, etc."/></label>
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
    </MoreDetails></section>}
  </>;
}
