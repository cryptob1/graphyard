import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { NoHealthyAccountError, agentEnvironmentRoot, atomicPrivateWrite, checkAgentEnvironment, discoverAgentEnvironments, environmentKinds, readCredentialFile,
  type AccountSkip, type AgentEnvironment, type EnvironmentHealth, type EnvironmentKind, type EnvironmentProbe, type MasterConfig } from './master.js';
import { accountIneligibility, fleetRoles, liveSessions, proposedConcurrency, proposedRuntimes, type AgentRegistry, type FleetAccount, type FleetAccountInput, type FleetModel, type FleetRole, type FleetRoleName, type FleetRuntime, type FleetSession, type LaunchContract, type QuotaObservation, type SessionSkip } from './model/registry.js';

/**
 * The executor's side of the agent registry (GY-91).
 *
 * Every launch asks the control plane which session to run: the executor reads the registry,
 * probes the logins that live on its own host, reports what it saw, and the control plane picks
 * the first eligible account of the role and records the choice. Nothing is cached between
 * actions beyond the probe's own short cache, so a registry change takes effect on the next
 * action with no restart and no file edit. A role the registry does not define yet keeps
 * launching from the local profile, which is how an installation moves onto the registry one
 * role at a time.
 */
export type FleetConfig = Pick<MasterConfig, 'credentialFile'> & Partial<Pick<MasterConfig, 'url' | 'hostId' | 'run'>>;
export interface FleetProbe extends EnvironmentProbe { work?: string; principal?: string; /** Replaces the HTTP client, for executors embedded beside the control plane and for tests. */ registry?: FleetClient }
/** The three calls an executor makes. */
export interface FleetClient {
  document(): Promise<AgentRegistry>;
  select(request: { role: FleetRoleName; host: string; work: string | null; principal: string | null; observations: { account: string; quota: QuotaObservation }[] }): Promise<FleetSelection>;
  end(session: string, reason: string): Promise<void>;
}
export interface FleetSelection { selected: boolean; reason: string; skipped: SessionSkip[]; session: FleetSession | null; account: FleetAccount | null; runtime: FleetRuntime | null; model: FleetModel | null; revision: number }
/** The account a launch runs on, as `accountLaunch` reads it: the login home and the registry's launch contract. */
export interface FleetLaunchAccount { name: string; kind: string; home: string | null; fleet: { runtime: string; contract: LaunchContract; model: string; modelId: string | null; session: string; reason: string } }

export class FleetUnreachableError extends Error {}

export function httpFleetClient(config: Required<Pick<FleetConfig, 'url'>> & Pick<FleetConfig, 'credentialFile'>, fetcher: typeof fetch = fetch, timeoutMs = 10_000): FleetClient {
  const call = async (path: string, body?: unknown) => {
    const token = await readCredentialFile(config.credentialFile);
    let response: Response;
    try {
      response = await fetcher(`${config.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) { throw new FleetUnreachableError(`The agent registry at ${config.url} is unreachable: ${error instanceof Error ? error.message : 'unknown reason'}`); }
    const text = await response.text();
    let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* a proxy page, not the control plane */ }
    if (!response.ok || parsed === null) throw new FleetUnreachableError(`The agent registry at ${config.url} answered ${response.status}${parsed?.error ? `: ${parsed.error}` : ''}`);
    return parsed;
  };
  return { document: () => call('agent-registry/document'), select: request => call('agent-registry/select', request), end: async (session, reason) => { await call(`agent-registry/sessions/${session}/end`, { reason }); } };
}

// The registry as this executor last read it, kept beside the coordinator's other private state.
// It is never launched from: it only tells an unreachable control plane ("refuse, the registry
// decides this role") apart from one that never held a registry ("launch from the local profile").
const fleetCachePath = (config: Pick<MasterConfig, 'credentialFile'>) => resolve(dirname(config.credentialFile), `${basename(config.credentialFile).replace(/\.token$/, '')}.registry.json`);
async function readFleetCache(config: Pick<MasterConfig, 'credentialFile'>): Promise<{ revision: number; roles: string[]; readAt: string } | null> {
  try { const parsed = JSON.parse(await readFile(fleetCachePath(config), 'utf8')); return typeof parsed?.revision === 'number' && Array.isArray(parsed.roles) ? parsed : null; } catch { return null; }
}
// One failed read is not repeated for every launch of the same cycle.
const unreachable = new Map<string, { at: number; error: FleetUnreachableError }>();
export const unreachableRetryMs = 30_000;

export type FleetRead = { managed: true; registry: AgentRegistry; client: FleetClient } | { managed: false; reason: string };
/** Whether the registry decides `role` for this executor, and the registry when it does. */
export async function readFleet(config: FleetConfig, role: FleetRoleName, probe: FleetProbe = {}): Promise<FleetRead> {
  if (!probe.registry && (!config.url || !config.hostId)) return { managed: false, reason: 'this configuration names no control plane' };
  const client = probe.registry ?? httpFleetClient({ url: config.url!, credentialFile: config.credentialFile }, probe.fetch ?? fetch, probe.timeoutMs ?? 10_000);
  const now = probe.now?.() ?? Date.now(), failed = probe.registry ? undefined : unreachable.get(config.url!);
  let registry: AgentRegistry;
  try {
    if (failed && now - failed.at >= 0 && now - failed.at < unreachableRetryMs) throw failed.error;
    registry = await client.document();
    if (!probe.registry) unreachable.delete(config.url!);
  } catch (error) {
    if (!(error instanceof FleetUnreachableError)) throw error;
    if (!probe.registry && error !== failed?.error) unreachable.set(config.url!, { at: now, error });
    const cached = await readFleetCache(config);
    // Once the registry has decided a role, an outage never quietly hands that role back to a file.
    if (cached?.roles.includes(role)) throw new Error(`${error.message}; role ${role} is decided by the agent registry (revision ${cached.revision}, read ${cached.readAt}), so nothing launches for it until the control plane answers`);
    return { managed: false, reason: error.message };
  }
  const roles = (registry.roles ?? []).map(entry => entry.name);
  const cached = await readFleetCache(config);
  if (!cached || cached.roles.join() !== roles.join()) await atomicPrivateWrite(fleetCachePath(config), { revision: registry.revision, roles, readAt: new Date(now).toISOString() }).catch(() => {});
  if (!roles.includes(role)) return { managed: false, reason: registry.roles?.length ? `role ${role} is not configured in the agent registry` : 'the agent registry is empty' };
  return { managed: true, registry, client };
}

const builtinProbe = (runtime: FleetRuntime): EnvironmentKind | null => (environmentKinds as readonly string[]).includes(runtime.launch.kind) ? runtime.launch.kind as EnvironmentKind : null;
/**
 * What this host can see of one account's login: Graphyard's own probe for the runtimes it can
 * read a login and a quota from, the contract's login file for any other runtime, and nothing
 * (unknown, which is launchable) when the account names no home.
 */
export async function observeAccount(account: FleetAccount, runtime: FleetRuntime, probe: EnvironmentProbe = {}): Promise<{ quota: QuotaObservation; health: EnvironmentHealth | null }> {
  const home = account.credential.home, kind = builtinProbe(runtime);
  if (!home) return { quota: { loggedIn: null, state: 'unknown', usage: [], resetsAt: null, reason: null }, health: null };
  if (kind) {
    const health = await checkAgentEnvironment({ name: account.name, kind, home }, probe);
    const resets = health.usage.map(entry => entry.resetsAt).filter((value): value is string => !!value).sort();
    return { health, quota: { loggedIn: health.loggedIn, state: health.loggedIn ? health.quota : 'unknown', usage: health.usage.map(entry => ({ window: entry.window, percent: entry.percent, resetsAt: entry.resetsAt })),
      resetsAt: health.quota === 'exhausted' ? resets.at(-1) ?? null : null, reason: health.reason ? health.reason.slice(0, 500) : null } };
  }
  if (!runtime.launch.loginFile) return { quota: { loggedIn: null, state: 'unknown', usage: [], resetsAt: null, reason: null }, health: null };
  const loggedIn = await access(resolve(home, runtime.launch.loginFile)).then(() => true, () => false);
  return { health: null, quota: { loggedIn, state: 'unknown', usage: [], resetsAt: null, reason: loggedIn ? null : `${account.name} is not logged in${runtime.launch.login ? `; log in with: ${runtime.launch.login.replaceAll('{home}', home)}` : ''}` } };
}

/**
 * The session a launch runs on, chosen by the control plane — or null when the registry does not
 * decide this role, and the caller launches from its local profile. A refusal is the same error a
 * profile without a healthy account raises, so callers that fail over between profiles still do.
 */
export async function selectFleetSession(config: FleetConfig, role: FleetRoleName, profile: { name: string; principal?: string }, probe: FleetProbe = {}) {
  const fleet = await readFleet(config, role, probe);
  if (!fleet.managed) return null;
  const host = config.hostId ?? 'unknown-host', { registry, client } = fleet;
  const named = registry.roles.find(entry => entry.name === role)!.accounts;
  const local = registry.accounts.filter(account => named.includes(account.name) && account.enabled && account.credential.host === host);
  const ceiling = probe.ceilingPercent ?? config.run?.quotaCeilingPercent;
  const observed = await Promise.all(local.map(async account => {
    const runtime = registry.runtimes.find(entry => entry.name === account.runtime);
    return runtime ? { account: account.name, ...await observeAccount(account, runtime, { ...probe, ceilingPercent: ceiling }) } : null;
  }));
  const observations = observed.filter((entry): entry is NonNullable<typeof entry> => !!entry);
  const chosen = await client.select({ role, host, work: probe.work ?? null, principal: probe.principal ?? profile.principal ?? null, observations: observations.map(({ account, quota }) => ({ account, quota })) });
  const at = new Date(probe.now?.() ?? Date.now()).toISOString();
  const skipped: AccountSkip[] = chosen.skipped.map(entry => ({ at, role: role as AccountSkip['role'], profile: profile.name, environment: entry.account, reason: entry.reason, work: probe.work ?? null }));
  if (!chosen.selected || !chosen.account || !chosen.runtime || !chosen.model || !chosen.session)
    throw new NoHealthyAccountError(`No healthy agent account for ${role} profile ${profile.name}: ${chosen.reason}`, skipped);
  const account: FleetLaunchAccount = { name: chosen.account.name, kind: chosen.runtime.launch.kind, home: chosen.account.credential.home,
    fleet: { runtime: chosen.runtime.name, contract: chosen.runtime.launch, model: chosen.model.name, modelId: chosen.model.id, session: chosen.session.id, reason: chosen.reason } };
  return { account, health: observations.find(entry => entry.account === chosen.account!.name)?.health ?? null, skipped, selection: chosen, release: (reason: string) => client.end(chosen.session!.id, reason).catch(() => {}) };
}

/**
 * Whether a role can launch from the registry right now, without choosing anything: what the
 * durable loop and `master status` read before they dispatch. Null when the registry does not
 * decide the role.
 */
export async function fleetRoleHealth(config: FleetConfig, role: FleetRoleName, probe: FleetProbe = {}) {
  let fleet: FleetRead;
  try { fleet = await readFleet(config, role, probe); } catch (error) { return { available: false, reason: error instanceof Error ? error.message : 'The agent registry is unreachable', accounts: [] }; }
  if (!fleet.managed) return null;
  const host = config.hostId ?? null, now = probe.now?.() ?? Date.now(), definition = fleet.registry.roles.find(entry => entry.name === role)!;
  const accounts = definition.accounts.map(name => {
    const account = fleet.registry.accounts.find(entry => entry.name === name);
    const reason = account ? accountIneligibility(fleet.registry, account, now, host) : `${name} is not a registered account`;
    return { environment: name, healthy: !reason, reason, quota: account?.quota.state ?? 'unknown' };
  });
  const running = liveSessions(fleet.registry).filter(session => session.role === role).length;
  const full = running >= definition.concurrency ? `role ${role} is at its concurrency limit (${running} of ${definition.concurrency} live)` : null;
  const usable = !full && accounts.some(account => account.healthy);
  return { available: usable, reason: usable ? null : full ?? `No eligible account for ${role}: ${accounts.map(account => account.reason).join('; ') || 'the role names no account'}`, accounts };
}

// ---------------------------------------------------------------------------
// Setup: discover what the host already has, and propose a registry from it.
// ---------------------------------------------------------------------------

export interface HostLogin { name: string; runtime: string; home: string | null; loggedIn: boolean | null; quota: EnvironmentHealth['quota']; reason: string | null; login: string | null; source: 'environment' | 'default-home' | 'executable' }
const defaultHomes: Record<EnvironmentKind, (home: string) => string> = {
  claude: home => resolve(home, '.claude'), codex: home => resolve(home, '.codex'), cursor: home => resolve(home, '.cursor'),
  opencode: home => process.env.XDG_DATA_HOME ?? resolve(home, '.local/share'),
};
const onPath = (executable: string) => { try { execFileSync('which', [executable], { stdio: 'ignore' }); return true; } catch { return false; } };

/**
 * The agent CLIs already logged in on this host: every isolated environment under the agent
 * environment directory, each runtime's own default login home, and the executables of proposed
 * runtimes that keep their login somewhere Graphyard does not read (reported, never assumed).
 */
export async function discoverHostLogins(options: { directory?: string; home?: string; probe?: EnvironmentProbe; executables?: (name: string) => boolean } = {}): Promise<HostLogin[]> {
  // Discovery answers "what is logged in right now": never a cached look, and never the provider.
  const home = options.home ?? homedir(), probe = { quota: false, cacheMs: 0, ...options.probe };
  const environments = await discoverAgentEnvironments(agentEnvironmentRoot(options.directory));
  const found: HostLogin[] = [];
  const check = async (environment: AgentEnvironment, source: HostLogin['source']) => {
    const health = await checkAgentEnvironment(environment, probe);
    found.push({ name: environment.name, runtime: environment.kind, home: environment.home, loggedIn: health.loggedIn, quota: health.quota, reason: health.reason, login: health.login, source });
  };
  for (const environment of environments) await check(environment, 'environment');
  for (const kind of environmentKinds) {
    const location = defaultHomes[kind](home);
    if (found.some(entry => entry.home === location)) continue;
    const name = found.some(entry => entry.name === kind) ? `${kind}-default` : kind;
    const health = await checkAgentEnvironment({ name, kind, home: location }, probe);
    // A default home nobody logged in to is not an account; an isolated environment is kept either way.
    if (health.loggedIn) found.push({ name, runtime: kind, home: location, loggedIn: true, quota: health.quota, reason: health.reason, login: null, source: 'default-home' });
  }
  const has = options.executables ?? onPath;
  for (const runtime of proposedRuntimes) {
    if ((environmentKinds as readonly string[]).includes(runtime.name) || found.some(entry => entry.runtime === runtime.name) || !has(runtime.launch.kind)) continue;
    found.push({ name: runtime.name, runtime: runtime.name, home: null, loggedIn: null, quota: 'unknown', reason: null, login: runtime.launch.login, source: 'executable' });
  }
  return found;
}

export interface FleetProposal { runtimes: FleetRuntime[]; models: FleetModel[]; accounts: FleetAccountInput[]; roles: FleetRole[] }
/**
 * A registry for what discovery found, merged onto what the control plane already holds: a
 * runtime per discovered CLI with its proposed launch contract, one model per runtime standing
 * for "the account's own default" (an operator names the real model and its cost afterwards),
 * one account per logged-in login on this host, and every role over those accounts in discovery
 * order. Nothing already registered is changed: existing runtimes, models, accounts and role
 * orders stand, and new accounts are appended to the roles that exist.
 */
export function proposeFleet(logins: HostLogin[], host: string, current: Pick<AgentRegistry, 'runtimes' | 'models' | 'accounts' | 'roles'> = { runtimes: [], models: [], accounts: [], roles: [] }): FleetProposal {
  const usable = logins.filter(login => login.loggedIn !== false);
  const runtimes = [...new Set(usable.map(login => login.runtime))].filter(name => !current.runtimes.some(runtime => runtime.name === name))
    .flatMap(name => proposedRuntimes.filter(runtime => runtime.name === name));
  const known = (name: string) => current.runtimes.some(runtime => runtime.name === name) || runtimes.some(runtime => runtime.name === name);
  const modelName = (runtime: string) => `${runtime}-default`;
  const taken = new Set(current.accounts.map(account => account.name));
  const sameLogin = (login: HostLogin) => current.accounts.some(account => account.runtime === login.runtime && account.credential.host === host && account.credential.home === login.home);
  const accounts: FleetAccountInput[] = [];
  for (const login of usable.filter(entry => known(entry.runtime) && !sameLogin(entry))) {
    let name = login.name; for (let suffix = 2; taken.has(name); suffix++) name = `${login.name}-${suffix}`;
    taken.add(name);
    const used = current.accounts.find(account => account.runtime === login.runtime)?.model;
    accounts.push({ name, runtime: login.runtime, model: used ?? modelName(login.runtime), credential: { host, home: login.home }, enabled: true, maxSessions: null });
  }
  const models: FleetModel[] = [...new Set(accounts.map(account => account.model))].filter(name => !current.models.some(model => model.name === name))
    .map(name => ({ name, id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong' as const, contextTokens: null, notes: 'The account\'s own default model; name the real model, its cost and capability with master registry model set' } }));
  const added = accounts.map(account => account.name);
  const roles: FleetRole[] = !added.length ? [] : fleetRoles.map(name => {
    const existing = current.roles.find(role => role.name === name);
    return existing ? { ...existing, accounts: [...existing.accounts, ...added.filter(account => !existing.accounts.includes(account))] } : { name, accounts: added, concurrency: proposedConcurrency[name] };
  });
  return { runtimes, models, accounts, roles };
}
