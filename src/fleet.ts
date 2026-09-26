import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { NoHealthyAccountError, agentEnvironmentRoot, atomicPrivateWrite, checkAgentEnvironment, discoverAgentEnvironments, environmentKinds, masterConfigSchema, readCredentialFile,
  type AccountSkip, type AccountSkipCause, type AgentEnvironment, type EnvironmentHealth, type EnvironmentKind, type EnvironmentProbe, type MasterConfig } from './master.js';
import { shellQuote } from './master/dispatch.js';
import { sessionName } from './session-name.js';
import { accountIneligibility, fleetRoles, liveSessions, proposedConcurrency, proposedRuntimeRoles, proposedRuntimes, rolePolicy, type AgentRegistry, type RolePolicy, type FleetAccount, type FleetAccountInput, type FleetModel, type FleetRole, type FleetRoleName, type FleetRuntime, type FleetSession, type LaunchContract, type QuotaObservation, type SessionSkip } from './model/registry.js';

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
export interface FleetProbe extends EnvironmentProbe { work?: string; principal?: string; /** The proof group a producer launch answers; one live session per group, not per item. */ group?: string; /** Replaces the HTTP client, for executors embedded beside the control plane and for tests. */ registry?: FleetClient;
  /** The runtime sessions Herdr lists on this host right now: a registry session whose runtime session is gone does not count toward its role (GY-190). */
  runtime?: RuntimeInventory }
/** What Herdr listed on the executor's own host, and whether it could be read at all. */
export interface RuntimeInventory { agents: { name?: string | null }[]; available: boolean }
/** The three calls an executor makes. */
export interface FleetClient {
  document(): Promise<AgentRegistry>;
  select(request: { role: FleetRoleName; host: string; work: string | null; group: string | null; principal: string | null; observations: { account: string; quota: QuotaObservation }[] }): Promise<FleetSelection>;
  end(session: string, reason: string): Promise<void>;
}
export interface FleetSelection { selected: boolean; reason: string; skipped: SessionSkip[]; session: FleetSession | null; account: FleetAccount | null; runtime: FleetRuntime | null; model: FleetModel | null;
  /** The role's launch policy the choice was made under (GY-170); a server that predates it sends none, and the document's is used. */
  policy?: RolePolicy | null; revision: number }
/**
 * The account a launch runs on, as `accountLaunch` reads it: the login home, the registry's launch
 * contract, the model, and the role's launch policy, all from the registry revision it was chosen in.
 */
export interface FleetLaunchAccount { name: string; kind: string; home: string | null; fleet: { runtime: string; contract: LaunchContract; model: string; modelId: string | null; session: string; reason: string;
  role?: FleetRoleName; policy?: RolePolicy; revision?: number } }

export class FleetUnreachableError extends Error {}
/**
 * A launch the registry refused only because its role is at its concurrency limit (GY-190). It is
 * not a fault of any account and not a decision to give up on: the launch waits for a slot, and the
 * loop makes it again on the first cycle after one frees.
 */
export const roleAtCapacity = (reason: string) => /^role \S+ is at its concurrency limit\b/.test(reason);
/** The refusal's reason when `error` is a launch refused for its role's capacity, else null. (A tag, not a subclass: fleet.ts and master.ts import each other.) */
export const capacityRefusal = (error: unknown): string | null => { const tag = error instanceof Error ? (error as Error & { roleAtCapacity?: unknown }).roleAtCapacity : null; return typeof tag === 'string' ? tag : null; };

/**
 * How long a registry session is left alone after its selection before its runtime session is
 * looked for: the launch that follows a selection creates the Herdr tab within seconds, and a launch
 * on another process of this host may still be making it.
 */
export const runtimeGraceMs = 60_000;
/** The Herdr name prefixes every approver session for `key` starts with (see `approverSessionName`). */
const approverPrefixes = (key: string) => ['graphyard-approver', 'gy-approver'].map(prefix => `${sessionName(prefix, key)}-`);
/**
 * Why a live registry session no longer has a runtime session behind it, or null while it may. A
 * registry session records a launch, not a process: nothing reports a session's end, so a session
 * that judged its decision and exited kept its role's slot until its outer window passed, and after
 * `concurrency` launches the role stopped launching (GY-190). Herdr is the host's own record of what
 * runs, so a session selected on this host, past the launch grace, whose runtime session Herdr no
 * longer lists, has ended. Only roles whose runtime session name the registry session determines are
 * judged here — an approver is named for its item — and only from an inventory that could be read;
 * every other role's liveness stays with its lease or request, which the control plane settles.
 */
export function runtimeSessionGone(session: FleetSession, runtime: RuntimeInventory | undefined, host: string | null | undefined, now: number): string | null {
  if (session.endedAt || !runtime?.available || !host || session.host !== host) return null;
  if (now - Date.parse(session.selectedAt) < runtimeGraceMs) return null;
  if (session.role !== 'approver' || !session.work) return null;
  const prefixes = approverPrefixes(session.work);
  if (runtime.agents.some(agent => !!agent.name && prefixes.some(prefix => agent.name!.startsWith(prefix)))) return null;
  return `its approver session for ${session.work} is gone from Herdr on ${host}`;
}

/**
 * Why the registry passed an account over, in the launcher's own three causes. Only a quota the
 * registry reads as spent is `exhausted`: a disabled, misplaced, unregistered or session-limited
 * account is something a master fixes in one command, and reporting it as spent would read as a
 * wait for a provider reset that never comes.
 */
export const skipCause = (reason: string): AccountSkipCause =>
  /is not logged in/.test(reason) ? 'logged-out' : /quota is exhausted/.test(reason) ? 'exhausted' : 'unconfigured';

/**
 * One authenticated control-plane call for the host-side fleet workers: the coordinator credential
 * is read here, so a credential this host cannot read is the control plane being unaskable, not a
 * fleet decision. `httpFleetClient` and the connect-account worker (GY-409) both go through it.
 */
export async function fleetRequest(config: Required<Pick<FleetConfig, 'url'>> & Pick<FleetConfig, 'credentialFile'>, path: string, init: { method?: 'GET' | 'POST'; body?: unknown; fetch?: typeof fetch; timeoutMs?: number; idempotencyKey?: string } = {}): Promise<any> {
  let token: string;
  try { token = await readCredentialFile(config.credentialFile); }
  catch (error) { throw new FleetUnreachableError(`The agent registry at ${config.url} cannot be asked: ${error instanceof Error ? error.message : 'the coordinator credential is unreadable'}`); }
  const body = init.body;
  let response: Response;
  try {
    response = await (init.fetch ?? fetch)(`${config.url}/api/${path}`, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'Idempotency-Key': init.idempotencyKey ?? randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (error) { throw new FleetUnreachableError(`The agent registry at ${config.url} is unreachable: ${error instanceof Error ? error.message : 'unknown reason'}`); }
  const text = await response.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* a proxy page, not the control plane */ }
  if (!response.ok || parsed === null) throw new FleetUnreachableError(`The agent registry at ${config.url} answered ${response.status}${parsed?.error ? `: ${parsed.error}` : ''}`);
  return parsed;
}

export function httpFleetClient(config: Required<Pick<FleetConfig, 'url'>> & Pick<FleetConfig, 'credentialFile'>, fetcher: typeof fetch = fetch, timeoutMs = 10_000): FleetClient {
  const call = (path: string, body?: unknown) => fleetRequest(config, path, { body, fetch: fetcher, timeoutMs });
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
  // A session of this role whose runtime session is gone is ended before the choice, so the role's
  // count is of sessions that actually run and a finished approver never refuses the next one.
  const now = probe.now?.() ?? Date.now();
  for (const session of liveSessions(registry).filter(entry => entry.role === role)) {
    const gone = runtimeSessionGone(session, probe.runtime, host, now);
    if (gone) await client.end(session.id, gone).catch(() => {});
  }
  const chosen = await client.select({ role, host, work: probe.work ?? null, group: probe.group ?? null, principal: probe.principal ?? profile.principal ?? null, observations: observations.map(({ account, quota }) => ({ account, quota })) });
  const at = new Date(now).toISOString();
  const skipped: AccountSkip[] = chosen.skipped.map(entry => ({ at, role: role as AccountSkip['role'], profile: profile.name, environment: entry.account, reason: entry.reason, work: probe.work ?? null, cause: skipCause(entry.reason) }));
  if (!chosen.selected || !chosen.account || !chosen.runtime || !chosen.model || !chosen.session)
    throw Object.assign(new NoHealthyAccountError(`No healthy agent account for ${role} profile ${profile.name}: ${chosen.reason}`, skipped), roleAtCapacity(chosen.reason) ? { roleAtCapacity: chosen.reason } : {});
  // `release` ends the selected session and says whether the registry was told: a caller that
  // cannot end it keeps its id, the only way to free the role's slot later.
  const policy = chosen.policy ?? rolePolicy(registry.roles.find(entry => entry.name === role));
  const account: FleetLaunchAccount = { name: chosen.account.name, kind: chosen.runtime.launch.kind, home: chosen.account.credential.home,
    fleet: { runtime: chosen.runtime.name, contract: chosen.runtime.launch, model: chosen.model.name, modelId: chosen.model.id, session: chosen.session.id, reason: chosen.reason, role, policy, revision: chosen.revision } };
  return { account, health: observations.find(entry => entry.account === chosen.account!.name)?.health ?? null, skipped, selection: chosen, release: (reason: string) => client.end(chosen.session!.id, reason).then(() => true, () => false) };
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
    return { environment: name, healthy: !reason, reason, quota: account?.quota.state ?? 'unknown', resetsAt: account?.quota.resetsAt ?? null };
  });
  const running = liveSessions(fleet.registry).filter(session => session.role === role && !runtimeSessionGone(session, probe.runtime, host, now)).length;
  const full = running >= definition.concurrency ? `role ${role} is at its concurrency limit (${running} of ${definition.concurrency} live)` : null;
  const usable = !full && accounts.some(account => account.healthy);
  return { available: usable, reason: usable ? null : full ?? `No eligible account for ${role}: ${accounts.map(account => account.reason).join('; ') || 'the role names no account'}`, accounts };
}

/**
 * The loop's reconciliation of the registry against what runs (GY-190): every live registry session
 * whose runtime session is gone from this host's Herdr, and every session the caller names as
 * finished (an approver whose decision is judged), is ended with the reason why. Returns what it
 * ended. A configuration that names no control plane has no registry to reconcile.
 */
export async function reconcileFleetSessions(config: FleetConfig, runtime: RuntimeInventory, finished: ReadonlyMap<string, string>, probe: FleetProbe = {}) {
  if (!probe.registry && (!config.url || !config.hostId)) return [];
  const client = probe.registry ?? httpFleetClient({ url: config.url!, credentialFile: config.credentialFile }, probe.fetch ?? fetch, probe.timeoutMs ?? 10_000);
  const registry = await client.document(), now = probe.now?.() ?? Date.now(), ended: { session: string; role: FleetRoleName; work: string | null; account: string; reason: string }[] = [];
  for (const session of liveSessions(registry)) {
    const reason = finished.get(session.id) ?? runtimeSessionGone(session, runtime, config.hostId, now);
    if (!reason) continue;
    await client.end(session.id, reason);
    ended.push({ session: session.id, role: session.role, work: session.work, account: session.account, reason });
  }
  return ended;
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
  // A runtime Graphyard has no probe of its own for (Pi) keeps each login in an `<runtime>-<letter>`
  // environment too; its readiness is only whether the contract's login file exists — never read.
  for (const location of await runtimeEnvironments(agentEnvironmentRoot(options.directory))) {
    const loggedIn = await access(resolve(location.home, location.runtime.launch.loginFile!)).then(() => true, () => false);
    found.push({ name: location.name, runtime: location.runtime.name, home: location.home, loggedIn, quota: 'unknown', reason: loggedIn ? null : `${location.name} is not logged in`,
      login: loggedIn ? null : location.runtime.launch.login?.replaceAll('{home}', location.home) ?? null, source: 'environment' });
  }
  const has = options.executables ?? onPath;
  for (const runtime of proposedRuntimes) {
    if ((environmentKinds as readonly string[]).includes(runtime.name) || found.some(entry => entry.runtime === runtime.name) || !has(runtime.launch.kind)) continue;
    found.push({ name: runtime.name, runtime: runtime.name, home: null, loggedIn: null, quota: 'unknown', reason: null, login: runtime.launch.login, source: 'executable' });
  }
  return found;
}

/** Environment directories of the proposed runtimes Graphyard has no probe of its own for: `pi`, `pi-a`, `pi-b`. */
async function runtimeEnvironments(directory: string) {
  const runtimes = proposedRuntimes.filter(runtime => !(environmentKinds as readonly string[]).includes(runtime.name) && runtime.launch.homeVariable && runtime.launch.loginFile);
  let entries: string[];
  try { entries = await readdir(directory); } catch { return []; }
  const found: { name: string; home: string; runtime: FleetRuntime }[] = [];
  for (const name of entries.sort()) {
    const runtime = runtimes.find(entry => new RegExp(`^${entry.name}(?:-[a-z0-9][a-z0-9_-]{0,30})?$`).test(name));
    if (!runtime) continue;
    const home = resolve(directory, name);
    if (await stat(home).then(entry => entry.isDirectory(), () => false)) found.push({ name, home, runtime });
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
  const serves = (account: FleetAccountInput, role: FleetRoleName) => proposedRuntimeRoles[account.runtime]?.includes(role) ?? true;
  const roles: FleetRole[] = !accounts.length ? [] : fleetRoles.flatMap(name => {
    const added = accounts.filter(account => serves(account, name)).map(account => account.name);
    const existing = current.roles.find(role => role.name === name);
    if (existing) return [{ ...existing, accounts: [...existing.accounts, ...added.filter(account => !existing.accounts.includes(account))] }];
    return added.length ? [{ name, accounts: added, concurrency: proposedConcurrency[name] }] : [];
  });
  return { runtimes, models, accounts, roles };
}

// ---------------------------------------------------------------------------
// Connect an account from the UI (GY-409).
//
// The catalog below is everything the browser, the control plane and the host's
// executor agree on about the providers an operator can connect without a shell:
// what each one is called, whether it takes a pasted API key or the provider's
// own subscription login, which runtime and registry model its account runs,
// which file inside the login home holds its credential and what that file
// looks like, the login command whose output is relayed to the operator, and
// the one-line smoke prompt that decides whether the card turns healthy.
// Everything here is pure: the writes and spawns live in src/master/environments.ts.
// ---------------------------------------------------------------------------

/** A provider an operator connects from Settings › Agents. */
export interface ConnectProvider {
  /** Stable id on the wire (`connect.provider`). */
  id: string;
  /** The operator-facing name the UI shows. */
  label: string;
  /** `api-key` providers take a pasted key sealed to the agent host; `subscription` providers run their own login. */
  kind: 'api-key' | 'subscription';
  /** The registry runtime the account runs on. */
  runtime: string;
  /** The registry model the account runs; added when the registry lacks it, left alone when it has one. */
  model: string;
  /** The capability class the default role placement follows (GY-409 AC-4). */
  tier: 'strong' | 'fast';
  /** Path of the provider's own auth file inside the login home, for `api-key` providers. */
  authFile?: string;
  /** The provider's auth file content: what `key` becomes, laid over whatever the file already held. */
  authDocument?: (existing: Record<string, unknown>, key: string) => Record<string, unknown>;
  /** The provider's own login command for `subscription` providers, and the env variable that selects the login home. */
  login?: { command: string; args: string[]; envVariable: string };
  /** Path inside the login home whose presence means the login completed. */
  loginFile?: string;
  /** The one-line smoke prompt: what is run inside the login home to decide the card's health. */
  smoke: { command: string; args: string[]; envVariable: string };
  /** One line of UI help under the provider's picker entry. */
  help: string;
}

const smokePrompt = 'Reply with the single word: ok';

/** The providers Settings › Agents offers, in the order the picker shows them. */
export const connectProviders: readonly ConnectProvider[] = [
  {
    id: 'z.ai', label: 'z.ai (GLM coding plan)', kind: 'api-key', runtime: 'opencode', model: 'opencode-default', tier: 'fast',
    authFile: 'opencode/auth.json',
    // OpenCode's auth entries are a union discriminated on `type`: without `type: 'api'` it
    // discards the entry, so the pasted key would never be used and the smoke would pass on
    // whatever other provider the host still had.
    authDocument: (existing, key) => ({ ...existing, 'zai-coding-plan': { ...(existing['zai-coding-plan'] as Record<string, unknown> | undefined ?? {}), type: 'api', key } }),
    // The smoke pins the provider and model, so "healthy" means this key answered.
    smoke: { command: 'opencode', args: ['run', '--model', 'zai-coding-plan/glm-5.3-flash', smokePrompt], envVariable: 'XDG_DATA_HOME' },
    help: 'Your z.ai coding-plan key, wrapped by OpenCode. Cheap-model accounts join research, approval and proofs.',
  },
  {
    id: 'anthropic-api', label: 'Anthropic API', kind: 'api-key', runtime: 'claude', model: 'claude-default', tier: 'strong',
    authFile: 'settings.json',
    authDocument: (existing, key) => ({ ...existing, env: { ...((existing.env ?? {}) as Record<string, unknown>), ANTHROPIC_API_KEY: key } }),
    smoke: { command: 'claude', args: ['-p', smokePrompt], envVariable: 'CLAUDE_CONFIG_DIR' },
    help: 'An Anthropic API key Claude Code bills to your API account.',
  },
  {
    id: 'openai-api', label: 'OpenAI API', kind: 'api-key', runtime: 'codex', model: 'codex-default', tier: 'strong',
    authFile: 'auth.json',
    authDocument: (existing, key) => ({ ...existing, OPENAI_API_KEY: key }),
    smoke: { command: 'codex', args: ['exec', smokePrompt], envVariable: 'CODEX_HOME' },
    help: 'An OpenAI API key Codex bills to your API account.',
  },
  {
    id: 'claude', label: 'Claude (subscription)', kind: 'subscription', runtime: 'claude', model: 'claude-default', tier: 'strong',
    login: { command: 'claude', args: ['login'], envVariable: 'CLAUDE_CONFIG_DIR' }, loginFile: '.credentials.json',
    smoke: { command: 'claude', args: ['-p', smokePrompt], envVariable: 'CLAUDE_CONFIG_DIR' },
    help: 'Your Claude subscription. Finish the sign-in in your own browser.',
  },
  {
    id: 'chatgpt', label: 'ChatGPT / Codex (subscription)', kind: 'subscription', runtime: 'codex', model: 'codex-default', tier: 'strong',
    login: { command: 'codex', args: ['login'], envVariable: 'CODEX_HOME' }, loginFile: 'auth.json',
    smoke: { command: 'codex', args: ['exec', smokePrompt], envVariable: 'CODEX_HOME' },
    help: 'Your ChatGPT plan, through the Codex CLI. Finish the sign-in in your own browser.',
  },
  {
    id: 'cursor', label: 'Cursor (subscription)', kind: 'subscription', runtime: 'cursor', model: 'cursor-default', tier: 'strong',
    login: { command: 'cursor-agent', args: ['login'], envVariable: 'CURSOR_CONFIG_DIR' }, loginFile: 'cli-config.json',
    smoke: { command: 'cursor-agent', args: ['-p', smokePrompt], envVariable: 'CURSOR_CONFIG_DIR' },
    help: 'Your Cursor plan. Finish the sign-in in your own browser.',
  },
];

/** The provider a connect request names, or null when it names no known one. */
export const connectProvider = (id: string): ConnectProvider | null => connectProviders.find(entry => entry.id === id) ?? null;

/**
 * The roles a newly connected account joins by default, by capability (GY-409 AC-4): strong-model
 * accounts join worker and reviewer; cheap models (GLM, Flash-class) join research, the approver
 * and the unit producer. Every role listed that exists in the registry takes the account appended
 * to its failover order. `research` is the host's own (master.json) configuration, not a registry
 * role: the account joins it only once the host has made the account's Pi wrapper the research
 * command, and the host's result is what reports it — the card never claims a placement the
 * fleet cannot launch.
 */
export function connectDefaultRoles(tier: ConnectProvider['tier']): readonly string[] {
  return tier === 'fast' ? ['research', 'approver', 'producer'] : ['worker', 'reviewer'];
}

/** The URL a provider's login printed, and the device or one-time code beside it, or nulls. */
export function parseLoginOutput(text: string): { url: string | null; code: string | null } {
  const url = text.match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? null;
  const code = text.match(/(?:one-time|device|verification)?\s*code(?:\s*is)?[:\s]+([A-Za-z0-9][A-Za-z0-9-]{3,30})/i)?.[1] ?? null;
  return { url, code };
}

/**
 * Start the provider's own login inside a fresh login home and relay what it prints (GY-409): the
 * URL and code reach the UI as soon as they appear, the login file's arrival ends the wait, and
 * the caller runs the smoke prompt before the card turns healthy. The child is bounded: past the
 * window it is stopped and the failure is what the card shows.
 */
export async function relaySubscriptionLogin(provider: ConnectProvider, home: string, options: { login?: { command: string; args: string[] }; pollMs?: number; loginTimeoutMs?: number; onPrinted?: (printed: { url: string | null; code: string | null }) => unknown } = {}): Promise<{ url: string | null; code: string | null; loggedIn: boolean; error: string | null }> {
  const login = options.login ?? { command: provider.login!.command, args: provider.login!.args };
  const pollMs = options.pollMs ?? 2_000, timeoutMs = options.loginTimeoutMs ?? 10 * 60_000;
  const file = resolve(home, provider.loginFile ?? '');
  const seen = () => access(file).then(() => true, () => false);
  return await new Promise(done => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(login.command, login.args, { env: { ...process.env, [provider.login!.envVariable]: home }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { done({ url: null, code: null, loggedIn: false, error: `${login.command} could not be started: ${error instanceof Error ? error.message : 'unknown reason'}` }); return; }
    let text = '', found: { url: string | null; code: string | null } | null = null, settled = false;
    const finish = (result: { url: string | null; code: string | null; loggedIn: boolean; error: string | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit); clearInterval(polling); clearTimeout(settle);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      done(result);
    };
    const printed = () => { found ??= parseLoginOutput(text); return found; };
    // The login blocks until the operator signs in, and the operator needs the URL to do that: hand
    // it on the moment it is printed (with the code, once both are out or the output settles).
    let told = false, settle: ReturnType<typeof setTimeout> | undefined;
    const tell = () => {
      if (told || settled) return;
      const now = parseLoginOutput(text);
      if (!now.url && !now.code) return;
      clearTimeout(settle);
      const announce = () => { if (told || settled) return; told = true; found = parseLoginOutput(text); void Promise.resolve(options.onPrinted?.(found)).catch(() => {}); };
      if (now.url && now.code) announce(); else settle = setTimeout(announce, 500);
    };
    const read = (chunk: Buffer) => { text += chunk.toString(); tell(); };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    const limit = setTimeout(() => finish({ ...(found ?? { url: null, code: null }), loggedIn: false, error: `${login.command} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped` }), timeoutMs);
    const polling = setInterval(() => { if (settled) return; void seen().then(there => { if (there) finish({ ...(printed() ?? { url: null, code: null }), loggedIn: true, error: null }); }); }, pollMs);
    limit.unref?.(); polling.unref?.();
    child.on('error', error => finish({ ...(printed() ?? { url: null, code: null }), loggedIn: false, error: `${login.command} failed: ${error instanceof Error ? error.message : 'unknown reason'}` }));
    child.on('close', status => { void seen().then(there => {
      if (there) return finish({ ...(printed() ?? { url: null, code: null }), loggedIn: true, error: null });
      finish({ ...(printed() ?? { url: null, code: null }), loggedIn: false, error: `${login.command} exited ${status ?? 'to a signal'} before the login file appeared` });
    }); });
  });
}

/**
 * The provider error an operator is shown, with the credential itself cut out: a provider that
 * echoes the pasted key back in an error message must not carry it onto a card, into history or
 * into a log line.
 */
export const redactKey = (text: string, key: string) => key.length > 8 ? text.split(key).join('[redacted]') : text;

/**
 * Research joins through a Pi wrapper (GY-409 AC-4): `pi-<letter>` reads the provider key at run
 * time from the account's login home and execs `pi`, so a cheap account can serve research without
 * the key being copied anywhere. An existing wrapper is never overwritten; null says there was
 * nothing to write.
 */
export async function ensureResearchWrapper(name: string, home: string, options: { root?: string; binDirectory?: string } = {}): Promise<string | null> {
  const letter = name.match(/-([a-z0-9]+)$/)?.[1];
  if (!letter) return null;
  const bin = options.binDirectory ?? resolve(homedir(), '.local/bin');
  const file = resolve(bin, `pi-${letter}`);
  if (await access(file).then(() => true, () => false)) return null;
  // Paths are shell-quoted: a home carrying a quote or a `$` must not break or inject into the wrapper.
  const piDirectory = shellQuote(resolve(agentEnvironmentRoot(options.root), `pi-${letter}`));
  const script = [
    '#!/usr/bin/env bash',
    `# pi, env ${letter}: the provider key is read at run time from its login home; never stored here.`,
    `mkdir -p ${piDirectory}`,
    `export PI_CODING_AGENT_DIR=${piDirectory}`,
    `export ZAI_API_KEY="$(node -e 'process.stdout.write(require(process.argv[1])["zai-coding-plan"].key)' ${shellQuote(resolve(home, 'opencode/auth.json'))})"`,
    'exec pi "$@"',
    '',
  ].join('\n');
  await mkdir(bin, { recursive: true });
  await writeFile(file, script, { mode: 0o755 });
  return file;
}

/**
 * Make the account's Pi wrapper the research command in the coordinator checkout's
 * .graphyard/master.json (GY-409 AC-4): a cheap account joins research only once the host's own
 * configuration can launch it. A research or Pi command the operator set is never replaced, and a
 * host with no readable master configuration appends nothing; false says so, and the connect's
 * result then claims only the registry roles.
 */
export async function appendResearchCommand(wrapper: string, options: { masterFile?: string } = {}): Promise<boolean> {
  const file = options.masterFile ?? resolve(process.cwd(), '.graphyard/master.json');
  let config: MasterConfig;
  try { config = masterConfigSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch { return false; }
  if (config.run.research?.command || config.run.pi?.command) return false;
  const parsed = masterConfigSchema.parse({ ...config, run: { ...config.run, research: { ...config.run.research, command: wrapper } } });
  await atomicPrivateWrite(file, parsed);
  return true;
}
