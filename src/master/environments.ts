import { registryToolsArgs } from '../registry-tools.js';
export { registryToolsArgs } from '../registry-tools.js';
// Concern: agent environments and accounts — discovery, health, quota, selection and the launch plan.
import { existsSync } from 'node:fs';
import { readdir, stat, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { defaultChildRun } from '../child-runner.js';
import { sessionName } from '../session-name.js';
import { launchPlan, assertNoApprovalOptOut, LaunchRefusedError } from '../harness.js';
import { type CapacityRole, type CapacityAccount, capacityRetryAt, quotaRoles } from '../model/capacity.js';
import { type FleetClient, type FleetLaunchAccount, type FleetProbe, selectFleetSession, fleetRoleHealth, httpFleetClient } from '../fleet.js';
import { type AgentEnvironment, agentEnvironmentSchema, type EnvironmentKind, environmentKinds, environmentVariable, type MasterConfig, masterConfigSchema, producerProfileSchema, reviewerProfileSchema, workerProfileSchema } from './profiles.js';
import { externalCredential, loadStoredMasterConfig } from './config.js';
import { atomicPrivateText, atomicPrivateWrite, readCredentialFile } from '../private-file.js';
import { installDirectory, readInstallRecord } from '../install/secrets.js';
import { installIdFor } from '../install/types.js';
import { failureText } from '../disk-space.js';
import { shellQuote } from '../shell-quote.js';
import { heldObservation, describeObservedExhaustion, providerIdentity } from './account-identity.js';
import { getCachedPlanUsage, setCachedPlanUsage } from '../provider-usage.js';
export { describeObservedExhaustion, heldObservation, heldOverlay, heldTwin, providerIdentity, registryHoldObservations, registryLogin, spentHere } from './account-identity.js';
// The per-provider login and quota probes live in ./environment-quota.ts, reached through each runtime's adapter.
import type { PlanReading } from './environment-quota.js';
import { runtimeAdapter, type AccountReading } from './runtimes.js';

/** Where agent environments live: one directory per account, named <agent>-<letter>. */
export function agentEnvironmentRoot(input?: string) {
  return resolve(input ?? process.env.GRAPHYARD_AGENT_ENVIRONMENTS ?? resolve(homedir(), '.coding_agents'));
}
const environmentDirectory = /^(claude|codex|opencode|cursor)(?:-([a-z0-9][a-z0-9_-]{0,30}))?$/;
export async function discoverAgentEnvironments(directory = agentEnvironmentRoot()): Promise<AgentEnvironment[]> {
  let entries: string[];
  try { entries = await readdir(directory); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  const found: AgentEnvironment[] = [];
  for (const name of entries) {
    const match = environmentDirectory.exec(name);
    if (!match) continue;
    const home = resolve(directory, name);
    try { if (!(await stat(home)).isDirectory()) continue; } catch { continue; }
    found.push(agentEnvironmentSchema.parse({ name, kind: match[1], home }));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
/** A new, empty environment for an agent CLI: the next free <agent>-<letter> directory, mode 0700. */
export async function createAgentEnvironment(directory: string, kind: EnvironmentKind, existing: AgentEnvironment[]) {
  const taken = new Set(existing.map(environment => environment.name));
  const letter = [...'abcdefghijklmnopqrstuvwxyz'].find(candidate => !taken.has(`${kind}-${candidate}`));
  if (!letter) throw new Error(`Every ${kind}-<letter> environment name is taken under ${directory}`);
  const home = resolve(directory, `${kind}-${letter}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  return agentEnvironmentSchema.parse({ name: `${kind}-${letter}`, kind, home });
}
/**
 * The one runtime setting a fresh environment needs before an unattended launch: Claude Code asks
 * once per config home to confirm the bypass-permissions mode every launch requests, and that
 * confirmation would hold a new session at a dialog nobody is watching.
 */
export async function prepareAgentEnvironment(environment: AgentEnvironment) {
  if (environment.kind !== 'claude') return [] as string[];
  const file = resolve(environment.home, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object; resolve it before preparing the environment`);
    settings = parsed;
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (settings.skipDangerousModePermissionPrompt === true) return [];
  await atomicPrivateText(file, `${JSON.stringify({ ...settings, skipDangerousModePermissionPrompt: true }, null, 2)}\n`);
  return [`${file}: skipDangerousModePermissionPrompt`];
}

export function loginCommand(environment: AgentEnvironment) {
  const home = shellQuote(environment.home);
  return { claude: `CLAUDE_CONFIG_DIR=${home} claude, then /login`, codex: `CODEX_HOME=${home} codex login`,
    opencode: `XDG_DATA_HOME=${home} opencode auth login`, cursor: `CURSOR_CONFIG_DIR=${home} agent login` }[environment.kind];
}

export interface AccountUsage { window: string; percent: number; resetsAt: string | null }
export interface EnvironmentHealth {
  name: string; kind: EnvironmentKind; home: string; variable: string; checkedAt: string;
  loggedIn: boolean; quota: 'available' | 'exhausted' | 'unknown'; usage: AccountUsage[];
  /** Launchable: logged in and not exhausted. Unknown quota is launchable; the runtime reports its own limit. */
  healthy: boolean; reason: string | null; note: string | null; login: string | null;
  /** The provider login behind the home (GY-1573): accounts that share one share one quota. Null when the login names none; absent when its file could not be read just now. */
  identity?: string | null;
}
export interface EnvironmentProbe {
  fetch?: typeof fetch; now?: () => number; ceilingPercent?: number; timeoutMs?: number; cacheMs?: number;
  /** false reads only the login, never the provider: for reports that must not reach the network. */
  quota?: boolean;
}
export const defaultQuotaCeilingPercent = 95;
const healthCache = new Map<string, { at: number; health: EnvironmentHealth }>();

/**
 * An environment as the fleet probes a registry account: the plan id derived for it, the plan the operator declared
 * (null when none), and the account's named key file and variable. Typed here rather than smuggled through `as any`,
 * so a caller that drops one of them fails to compile instead of silently probing the wrong key (GY-1210).
 */
export type ProbedEnvironment = AgentEnvironment & { plan?: string | null; declaredPlan?: string | null; keyFile?: string; keyVariable?: string; model?: string };
/**
 * The newest Z.AI quota reading any account's key answered with windows. A Pi account on a `zai/` model runs on the
 * operator's shared Z.AI credit, which its own key may not report (GY-2871: pi-a's key answered with no limits while
 * opencode-a's showed the credit spent), so with no windows of its own it reads this one.
 */
let latestZaiReading: PlanReading | null = null;
export async function checkAgentEnvironment(environment: ProbedEnvironment, probe: EnvironmentProbe = {}): Promise<EnvironmentHealth> {
  const now = probe.now?.() ?? Date.now(), ceiling = probe.ceilingPercent ?? defaultQuotaCeilingPercent;
  const adapter = runtimeAdapter(environment.kind), named = /^(?:pi|opencode)[-_]([a-zA-Z0-9]+)$/i.exec(environment.name)?.[1];
  const planId = environment.plan ?? (adapter?.sharedPlan || /zai|glm/i.test(environment.name) ? named ? `zai-${named.toLowerCase()}` : 'zai' : null);
  const cacheKey = `${environment.name}\0${environment.home}\0${ceiling}\0${probe.quota !== false}`, cached = healthCache.get(cacheKey);
  if (cached && now - cached.at >= 0 && now - cached.at < (probe.cacheMs ?? 30_000)) return cached.health;

  const account: AccountReading = adapter?.usage ? await adapter.usage(environment, probe, { plan: planId, now }) : { loggedIn: false, usage: [], note: `Graphyard reads no login of the ${environment.kind} runtime` };

  if (/^zai\//i.test(environment.model ?? '') && !account.usage.length && latestZaiReading)
    Object.assign(account, { loggedIn: true, usage: latestZaiReading.windows, note: latestZaiReading.reason, reached: latestZaiReading.reached, shared: true });
  else if (account.plan?.windows.length) latestZaiReading = account.plan;
  if (account.loggedIn && planId && !account.shared) {
    // A reading taken from the plan cache is not re-stamped, so the cache still expires. A provider
    // call that answered caches its own plan reading; only an account without one stamps its windows.
    const reading: PlanReading | null = account.plan ?? (account.usage.length > 0
      ? { reported: true, status: 'reported', windows: account.usage, resetsAt: account.usage.map(u => u.resetsAt).filter(Boolean).sort().at(-1) ?? null, reason: account.note, reached: account.reached }
      : null);
    if (reading) setCachedPlanUsage(planId, reading, now);
    else {
      const cachedPlan: PlanReading | null = getCachedPlanUsage(planId, now, probe.cacheMs ?? 30_000);
      if (cachedPlan && cachedPlan.reported && cachedPlan.windows.length > 0) {
        account.usage = cachedPlan.windows;
        if (cachedPlan.reason) account.note = cachedPlan.reason;
        if (cachedPlan.reached !== undefined) account.reached = cachedPlan.reached;
      }
    }
  }
  const future = (usage: AccountUsage) => !usage.resetsAt || Date.parse(usage.resetsAt) > now;
  const spent = account.usage.filter(usage => usage.percent >= ceiling && future(usage));
  const exhausted = spent.length > 0 || !!account.reached && account.usage.some(future);
  const quota = !account.loggedIn ? 'unknown' as const : exhausted ? 'exhausted' as const : account.usage.length ? 'available' as const : 'unknown' as const;
  const reason = !account.loggedIn ? `${environment.name} is not logged in`
    : exhausted ? `${environment.name} quota is exhausted (${(spent.length ? spent : account.usage).map(usage => `${usage.window} window at ${usage.percent}%${usage.resetsAt ? ` until ${usage.resetsAt}` : ''}`).join(', ')}; ceiling ${ceiling}%)` : null;
  const health: EnvironmentHealth = { name: environment.name, kind: environment.kind, home: environment.home, variable: environmentVariable[environment.kind], checkedAt: new Date(now).toISOString(),
    loggedIn: account.loggedIn, quota, usage: account.usage, healthy: !reason, reason, note: account.note, login: account.loggedIn ? null : loginCommand(environment),
    identity: account.loggedIn ? await providerIdentity(environment.kind, environment.home) : null };
  healthCache.set(cacheKey, { at: now, health });
  return health;
}

/** Every launched role selects its account the same way and skips the same spent accounts (GY-182). */
export type LaunchRole = CapacityRole;
/**
 * Why a launch passed an account over. Only `exhausted` — a quota read as spent, or one a session
 * itself reported — is the provider's capacity and waits for a reset. A logged-out account or a
 * name that is not a configured environment is something a master fixes in one command, so it must
 * keep reading as a launch that went wrong rather than as a wait (GY-89).
 */
export type AccountSkipCause = 'exhausted' | 'logged-out' | 'unconfigured' | 'cross-runtime';
export interface AccountSkip { at: string; role: LaunchRole; profile: string; environment: string; reason: string; work: string | null; cause: AccountSkipCause }
/** Every account of a profile was skipped: the caller fails over to its next profile, or reports the skips. */
export class NoHealthyAccountError extends Error {
  /** Fail over to the next profile: true for every reason an account was passed over. */
  readonly accountsExhausted = true;
  /** This profile has no capacity left: true only when every account it skipped was spent. */
  readonly capacityExhausted: boolean;
  constructor(message: string, readonly skipped: AccountSkip[]) {
    super(message);
    // An account of another runtime is never this role's to take (GY-1306): a profile whose own
    // runtime's accounts are all spent waits for their reset, whatever else it lists.
    const own = skipped.filter(skip => skip.cause !== 'cross-runtime');
    this.capacityExhausted = own.length > 0 && own.every(skip => skip.cause === 'exhausted');
  }
}

// What the launch loop last observed about each environment, and the recent launches it skipped
// away from and why, kept beside the coordinator's other private state so master status can say it.
const environmentLogSchema = z.object({
  version: z.literal(1),
  environments: z.record(z.string(), z.any()).default({}),
  skipped: z.array(z.object({ at: z.string(), role: z.enum(quotaRoles), profile: z.string(), environment: z.string(), reason: z.string().max(500), work: z.string().nullable(),
    // Logs written before GY-89 carry no cause; they read as the exhaustion the flag then meant.
    cause: z.enum(['exhausted', 'logged-out', 'unconfigured', 'cross-runtime']).default('exhausted') }).strict()).max(50).default([]),
  // Attribution and diagnostics only; legacy exhausted entries are discarded on read.
  selected: z.record(z.string(), z.object({ environment: z.string().nullable(), kind: z.string().nullable(), at: z.string(), work: z.string().nullable() }).strict()).default({}),
  exhausted: z.unknown().optional(),
  released: z.unknown().optional(),
}).strict();
/** A runtime limit notice reported to the registry, with its reset or a one-hour fallback. */
export interface ObservedExhaustion { at: string; until: string; resetsAt: string | null; reason: string; role: LaunchRole; profile: string; work: string | null; identity?: string | null; home?: string; kind?: string; reported?: boolean }
export const unknownResetHoldMs = 3_600_000;
export interface AccountSelection { environment: string | null; kind: string | null; at: string; work: string | null }
export type EnvironmentLog = { version: 1; environments: Record<string, EnvironmentHealth>; skipped: AccountSkip[]; selected: Record<string, AccountSelection>; exhausted: Record<string, ObservedExhaustion>; /** When an operator last released each account's hold (GY-3100): no notice read before it holds the account again. */ released?: Record<string, string> };
/** A profile that names no accounts launches on whatever its own environment selects; its exhaustion is held under this name. */
export const profileAccount = (profile: string) => `profile:${profile}`;
/**
 * The runtime's own login (GY-182): a session launched on `kind` with no named account and no home
 * of its own runs on it, whichever role it serves, so its exhaustion is held under this name as
 * well and every such launch of every role is refused until the reset.
 */
export const runtimeLogin = (kind: string) => `runtime:${kind}`;
/** Whether a profile that names no accounts launches on its runtime's own login, rather than a home its environment selects. */
const sharesRuntimeLogin = (profile: { kind?: string; environment?: Record<string, string> }) =>
  !!profile.kind && !Object.hasOwn(profile.environment ?? {}, environmentVariable[profile.kind as EnvironmentKind] ?? '');
/** The names a session on no named account is held under: the profile's own and, when it shares it, the runtime's own login. */
export const ownLoginAccounts = (profile: { name: string; kind?: string; environment?: Record<string, string> }) =>
  [profileAccount(profile.name), ...(sharesRuntimeLogin(profile) ? [runtimeLogin(profile.kind!)] : [])];
/** The hold, if any, that bars a launch of `profile` on no named account. */
export function ownLoginHold(held: Record<string, ObservedExhaustion>, profile: { name: string; kind?: string; environment?: Record<string, string> }) {
  const key = ownLoginAccounts(profile).find(name => held[name]);
  return key ? { key, held: held[key] } : null;
}
export const selectionKey = (role: LaunchRole, profile: string) => `${role}:${profile}`, sessionKeyOf = (key: string, work: string, group?: string | null) => `${key}|${work}${group ? `|${group}` : ''}`; // and one session's own beside it, by item and proof group, kept two days (GY-1582)
export function environmentLogPath(config: Pick<MasterConfig, 'credentialFile'>) {
  return resolve(dirname(config.credentialFile), `${basename(config.credentialFile).replace(/\.token$/, '')}.environments.json`);
}
export async function readEnvironmentLog(config: Pick<MasterConfig, 'credentialFile'>): Promise<EnvironmentLog> {
  try { return { ...environmentLogSchema.parse(JSON.parse(await readFile(environmentLogPath(config), 'utf8'))), exhausted: {} } as EnvironmentLog; }
  catch { return { version: 1, environments: {}, skipped: [], selected: {}, exhausted: {} }; }
}
/** Report a runtime's exhaustion directly to the registry; failures remain errors for reconciliation to retry. */
export async function recordObservedExhaustion(config: Pick<MasterConfig, 'credentialFile'> & Partial<Pick<MasterConfig, 'environments' | 'url' | 'hostId'>>, environment: string, observed: Omit<ObservedExhaustion, 'until'>, now = Date.now(),
  report?: { registry?: Pick<FleetClient, 'observe'> & Partial<Pick<FleetClient, 'document'>>; fetch?: typeof fetch }) {
  const reset = observed.resetsAt ? Date.parse(observed.resetsAt) : Number.NaN;
  const future = Number.isFinite(reset) && reset > now;
  const entry: ObservedExhaustion = { ...observed, resetsAt: future ? observed.resetsAt : null,
    reason: observed.reason.slice(0, 500), until: new Date(future ? reset : now + unknownResetHoldMs).toISOString() };
  const registry = report?.registry ?? (config.url ? httpFleetClient({ url: config.url, credentialFile: config.credentialFile }, report?.fetch ?? fetch) : null);
  if (!registry?.observe || !config.hostId) throw new Error('Reporting account exhaustion requires the control-plane registry');
  if (entry.identity === undefined && registry.document) {
    const document = await registry.document();
    const account = document.accounts.find(account => account.name === environment && account.credential.host === config.hostId);
    const runtime = document.runtimes.find(runtime => runtime.name === account?.runtime);
    const identity = account?.credential.home && runtime ? await providerIdentity(runtime.launch.kind, account.credential.home) : undefined;
    entry.identity = identity === undefined ? account?.quota.identity : identity;
  }
  await registry.observe({ host: config.hostId, observations: [{ account: environment, quota: heldObservation(environment, entry) }] });
  return entry;
}
/** Current exhaustion is read from the registry, never from the executor's environment log. */
export async function observedExhaustions(config: Pick<MasterConfig, 'credentialFile'> & Partial<Pick<MasterConfig, 'url' | 'hostId'>>, now = Date.now(), registry?: Pick<FleetClient, 'document'>): Promise<Record<string, ObservedExhaustion>> {
  const client = registry ?? (config.url ? httpFleetClient({ url: config.url, credentialFile: config.credentialFile }) : null);
  if (!client) return {};
  const document = await client.document();
  return Object.fromEntries(document.accounts.filter(account => account.quota.state === 'exhausted' && (!account.quota.resetsAt || Date.parse(account.quota.resetsAt) > now)).map(account => [account.name, {
    at: account.quota.observedAt ?? new Date(now).toISOString(), until: account.quota.resetsAt ?? new Date(now + unknownResetHoldMs).toISOString(),
    resetsAt: account.quota.resetsAt, reason: account.quota.reason ?? 'quota exhausted', role: 'worker', profile: '', work: null,
  }]));
}
/** Whether an operator set `account` available at or after `instant` (GY-3100, GY-3117): a notice printed by then is already overruled and never applied again. */
export async function releasedSince(config: Pick<MasterConfig, 'credentialFile'> & Partial<Pick<MasterConfig, 'url' | 'hostId'>>, account: string, instant: string, registry?: Pick<FleetClient, 'document'>) {
  const client = registry ?? (config.url ? httpFleetClient({ url: config.url, credentialFile: config.credentialFile }) : null);
  const entry = client && (await client.document()).accounts.find(candidate => candidate.name === account && (!config.hostId || candidate.credential.host === config.hostId));
  const decision = entry ? entry.quotaDecision ?? (entry.quota.source === 'operator' ? { state: entry.quota.state, at: entry.quota.observedAt ?? '' } : null) : null;
  return decision?.state === 'available' && Date.parse(decision.at) >= Date.parse(instant);
}
export async function recordEnvironmentLog(config: Pick<MasterConfig, 'credentialFile'>, health: EnvironmentHealth[], skipped: AccountSkip[] = [], selection?: { key: string; group?: string } & AccountSelection) {
  if (!health.length && !skipped.length && !selection) return;
  const log = await readEnvironmentLog(config);
  if (selection) { const { key, group, ...selected } = selection, at = Date.parse(selected.at); log.selected = { ...Object.fromEntries(Object.entries(log.selected).filter(([name, entry]) => !name.includes('|') || !(at - Date.parse(entry.at) > 2 * 86_400_000))), [key]: selected, ...selected.work ? { [sessionKeyOf(key, selected.work, group)]: selected } : {} }; }
  // A read that caught the login file mid-write keeps the identity last read (GY-1573).
  for (const entry of health) log.environments[entry.name] = entry.identity === undefined && log.environments[entry.name]?.identity !== undefined ? { ...entry, identity: log.environments[entry.name].identity } : entry;
  log.skipped = [...log.skipped, ...skipped.map(entry => ({ ...entry, reason: entry.reason.slice(0, 500) }))].slice(-50);
  await atomicPrivateWrite(environmentLogPath(config), log);
}

/** Every launch reserves its account and slot in the control-plane registry before starting. */
export const sameRuntimeRoles: readonly LaunchRole[] = ['reviewer', 'producer'];
export const crossRuntimeSkip = (role: LaunchRole, profile: { name: string; kind?: string }, account: { name: string; kind: string }) =>
  `${account.name} runs ${account.kind}, not ${profile.kind}: a ${role} launch of profile ${profile.name} starts only on ${profile.kind} accounts, so it waits for one rather than starting ${account.kind} in a checkout its ${profile.kind} launch prepared`;
export type LaunchAccount = AgentEnvironment | FleetLaunchAccount;
/** The agent registry session a launch was chosen under, or undefined when no registry chose it. */
export const registrySessionOf = (selected: Pick<LaunchSelection, 'account'> | null | undefined) => selected?.account && 'fleet' in selected.account ? selected.account.fleet.session : undefined;
export interface LaunchSelection { account: LaunchAccount | null; health: EnvironmentHealth | null; skipped: AccountSkip[]; /** Gives a registry session back when the launch it was chosen for failed; false when the registry could not be told. */ release?: (reason: string) => Promise<boolean> }
/** The registry's reservation, also recorded locally for launch attribution. */
export async function selectRegistryAccount(config: Pick<MasterConfig, 'credentialFile' | 'run'> & Partial<Pick<MasterConfig, 'url' | 'hostId'>>, role: LaunchRole, profile: { name: string; principal?: string }, probe: FleetProbe = {}) {
  const fleet = await selectFleetSession(config, role, profile, probe);
  if (fleet) await recordEnvironmentLog(config, fleet.health ? [fleet.health] : [], fleet.skipped, fleet.account ? { key: selectionKey(role, profile.name), environment: fleet.account.name, kind: fleet.account.kind, at: new Date(probe.now?.() ?? Date.now()).toISOString(), work: probe.work ?? null, group: probe.group } : undefined).catch(() => {}); // the registry's choice is the selection too (GY-1582)
  return fleet;
}
export async function selectAccount(config: Pick<MasterConfig, 'environments' | 'credentialFile' | 'run'> & Partial<Pick<MasterConfig, 'url' | 'hostId'>>, role: LaunchRole, profile: { name: string; accounts?: string[]; principal?: string; kind?: string; environment?: Record<string, string> }, probe: FleetProbe = {}): Promise<LaunchSelection> {
  return selectRegistryAccount(config, role, profile, probe);
}

/**
 * Run a launch on the session that was just chosen, and give that session back the moment
 * anything after the choice fails. Everything past selection can fail — a credential mismatch, a
 * token mint, a session harness, a Herdr tab, a prompt the runtime never took — and a session
 * that never ran would otherwise count against its account and its role for as long as the
 * request it answers stands: two hours for a reviewer, a day for a producer.
 */
export async function onSelectedSession<T>(selected: LaunchSelection, failed: string, launch: () => Promise<T>): Promise<T> {
  try { return await launch(); }
  catch (error) { await selected.release?.(`${failed}: ${failureText(error).slice(0, 300)}`); throw error; }
}

/**
 * Each runtime's broadest non-interactive approval mode. Claude Code, Codex and Cursor already get
 * theirs from the launch contract; OpenCode's contract allows edit, bash and webfetch only, so its
 * other permissions (directories outside the worktree, repeated tool calls, subagents, …) would
 * still stop a session to ask, and are allowed here too.
 */
export const openCodeAllowAll = { '*': 'allow', edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow', doom_loop: 'allow' };
/**
 * The external-directory permission a launch carries once its repository root is known (GY-2959):
 * the repository tree — every worktree beside the assigned one, its `.graphyard` tree included —
 * is granted, and everything outside the repository is denied, so a worker that bisects in a
 * second worktree or reads a sibling path never stops on the external-directory prompt for a
 * person. The explicit `.graphyard` entry keeps the grant readable beside the tree's, whichever
 * glob rules a runtime applies to dot-directories.
 */
export const openCodeRepositoryGrant = (root: string) => ({ [`${root}/**`]: 'allow', [`${root}/.graphyard/**`]: 'allow', '*': 'deny' });
/**
 * An operator's own OpenCode permission document that asks nothing (the recipe's `permits`) is laid
 * over the allow-all rather than replacing it: a key it leaves out (`external_directory`,
 * `doom_loop`, …) keeps Graphyard's `allow` — or, when the repository root is known, the
 * repository-tree grant — instead of falling back to OpenCode's default, which asks.
 */
function openCodePermission(operator: string | undefined, repositoryRoot?: string) {
  const base = repositoryRoot ? { ...openCodeAllowAll, external_directory: openCodeRepositoryGrant(repositoryRoot) } : openCodeAllowAll;
  if (operator === undefined) return JSON.stringify(base);
  const document: unknown = JSON.parse(operator);
  return document && typeof document === 'object' && !Array.isArray(document) ? JSON.stringify({ ...base, ...document }) : operator;
}
export function agentLaunchPlan(kind: string | undefined, approvals: 'auto' | 'prompt' = 'auto', agentArgs: string[] = [], environment: Record<string, string> = {}, repositoryRoot?: string) {
  const plan = launchPlan(kind, approvals, agentArgs, environment);
  if (!plan.applied || kind !== 'opencode') return plan;
  return { ...plan, environment: { ...plan.environment, OPENCODE_PERMISSION: openCodePermission(environment.OPENCODE_PERMISSION, repositoryRoot) }, prompts: 'every permission prompt, including edits, shell commands, fetches, and paths outside the worktree',
    tradeoff: 'opencode edits files, runs shell commands, fetches URLs, and reaches outside its worktree without asking.' };
}

/**
 * A registry account's startup arguments, from the revision it was chosen in: the runtime's contract,
 * then the role policy's flags (a permission mode, an auto-approve flag), its model on the runtime's
 * model flag and its tool allowlist on the runtime's tools flag. A role that limits tools on a runtime
 * with no tools flag is refused rather than launched with every tool.
 */
export function registryLaunchArgs(account: FleetLaunchAccount) {
  const { contract, policy, modelId } = account.fleet, args = [...contract.args, ...(policy?.args ?? [])];
  // OpenCode's interactive TUI refuses --model (only `run` takes it), so its model rides in
  // OPENCODE_CONFIG_CONTENT instead (GY-3118), whatever flag a stored runtime still names.
  const model = contract.kind !== 'opencode' && contract.modelFlag && modelId && !args.includes(contract.modelFlag) ? [contract.modelFlag, modelId] : [];
  return [...args, ...model, ...registryToolsArgs(account)];
}

/**
 * What a session launches with once its account is chosen: the account's kind and home, the
 * profile's arguments when they belong to that runtime, and the runtime's broadest approval mode.
 * Codex keeps its workspace sandbox, so the paths and network access the role needs are added to it:
 * a worker commits into the repository's shared Git directory and pushes; a producer builds in a
 * detached worktree under the managed worktree root, and is given its own session directory there
 * and nothing beside it.
 */
export function accountLaunch(profile: { kind?: string; approvals: 'auto' | 'prompt'; agentArgs: string[]; environment: Record<string, string> }, account: LaunchAccount | null, reach: { writable?: string[]; repositoryRoot?: string } = {}) {
  // A registry account carries its runtime's launch contract: what to start, its own startup
  // arguments, the variable that selects the login home, and the flag that selects its model.
  const contract = account && 'fleet' in account ? account.fleet.contract : null;
  const kind = account?.kind ?? profile.kind;
  // A registry launch takes its runtime, account, model and policy from the registry alone (GY-170):
  // the local profile's own arguments and environment apply only to roles the registry does not define.
  const fleetArgs = account && 'fleet' in account ? registryLaunchArgs(account) : null;
  const own = fleetArgs ?? (!account || account.kind === profile.kind ? profile.agentArgs : []);
  const profileEnvironment = fleetArgs ? {} : profile.environment;
  // An approvals opt-out is refused, naming the runtime, before any session starts (GY-184).
  assertNoApprovalOptOut(kind ?? 'unnamed', profile.approvals);
  const plan = agentLaunchPlan(kind, profile.approvals, fleetArgs ?? [...(contract?.args ?? []), ...own], { ...contract?.environment, ...profileEnvironment }, reach.repositoryRoot);
  // So is an effective launch whose own arguments or environment still let the runtime ask.
  if (plan.refusal) throw new LaunchRefusedError(kind ?? 'unnamed', plan.refusal);
  // The plan's variables come last: they are the recipe's, where the profile set none, or the
  // profile's own OpenCode permissions laid over the allow-all.
  // Keep the install's executable search path across interactive shell activation.
  // mise must not load unrelated checkout/operator configuration for an agent launch.
  const environment: Record<string, string> = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', MISE_NO_CONFIG: '1', ...contract?.environment, ...profileEnvironment, ...plan.environment };
  if (account) {
    // A runtime that names no home variable falls back to its kind's known one, and an account
    // whose home still cannot be applied is refused rather than started on the default login (GY-180).
    const variable = contract?.homeVariable ?? (Object.hasOwn(environmentVariable, account.kind) ? environmentVariable[account.kind as EnvironmentKind] : null);
    if (!variable && account.home) throw new LaunchRefusedError(account.kind, `Graphyard refuses to launch account ${account.name}: its home ${account.home} cannot be applied because ${contract && 'fleet' in account ? `runtime ${account.fleet.runtime}` : 'its environment'} names no login-home variable and the ${account.kind} kind has none known, so the session would run on the default login instead of ${account.name}. Set the runtime's home variable with master registry runtime set NAME --home-variable VAR.`);
    if (variable && account.home) environment[variable] = account.home;
    const modelId = 'fleet' in account ? account.fleet.modelId : null;
    if (kind === 'opencode' && modelId) environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...(environment.OPENCODE_CONFIG_CONTENT ? JSON.parse(environment.OPENCODE_CONFIG_CONTENT) : {}), model: modelId });
    // mise resolves installed runtimes under XDG_DATA_HOME; keep it on the operator's own install.
    if (variable === 'XDG_DATA_HOME' && account.home) {
      const mise = process.env.MISE_DATA_DIR ?? resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), '.local/share'), 'mise');
      if (existsSync(mise)) environment.MISE_DATA_DIR = mise;
    }
  }
  const extra = kind === 'codex' && plan.applied ? ['-c', 'sandbox_workspace_write.network_access=true', ...(reach.writable ?? []).flatMap(path => ['--add-dir', path])] : [];
  return { kind, args: [...plan.args, ...extra], environment, plan, account: account?.name ?? null, contract };
}

/** The Git directory every worktree of the repository commits into. */
export async function sharedGitDirectory(root: string) {
  try { return (await defaultChildRun('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root })).trim() || null; }
  catch { return null; }
}

/**
 * Account health for every profile that names accounts, joined onto the credential health status
 * and the durable loop already read: a profile none of whose accounts can launch is unavailable,
 * with each account's reason.
 */
export interface ProfileAccountHealth { environment: string; healthy: boolean; reason: string | null; quota: string; resetsAt: string | null }
export async function inspectProfileAccounts<T extends { available: boolean; reason: string | null }>(config: Pick<MasterConfig, 'environments' | 'credentialFile' | 'run'> & Partial<Pick<MasterConfig, 'url' | 'hostId'>>, role: LaunchRole, profiles: { name: string; accounts?: string[]; kind?: string; environment?: Record<string, string> }[], health: Record<string, T>, probe: EnvironmentProbe = {}) {
  const result: Record<string, T & { accounts?: ProfileAccountHealth[] }> = { ...health };
  const fleet = await fleetRoleHealth(config, role, probe);
  for (const profile of profiles) {
    if (result[profile.name]?.available === false) continue;
    result[profile.name] = { ...(result[profile.name] ?? { available: true, reason: null } as T),
      available: fleet?.available ?? false, reason: fleet?.reason ?? `Role ${role} must be configured in the control-plane registry`, accounts: fleet?.accounts ?? [] };
  }
  return result;
}

/** Registry accounts as this host knows them: one a session here saw spent is spent, whatever the registry last read. */
export function withHeldAccounts(accounts: ProfileAccountHealth[], held: Record<string, ObservedExhaustion>): ProfileAccountHealth[] {
  return accounts.map(account => held[account.environment] ? { ...account, healthy: false, reason: describeObservedExhaustion(account.environment, held[account.environment]), quota: 'exhausted', resetsAt: held[account.environment].resetsAt } : account);
}

/**
 * Whether a role has any account left. A role is out of capacity only when every launch profile
 * it has is unavailable for one reason — each of its accounts is spent — so a logged-out account
 * or an unreadable credential, which somebody can fix now, never reads as a wait for a reset.
 */
export interface RoleCapacity { role: CapacityRole; exhausted: boolean; accounts: CapacityAccount[]; retryAt: string | null }
export function roleCapacity(role: CapacityRole, profiles: { name: string }[], health: Record<string, { available: boolean; reason: string | null; accounts?: ProfileAccountHealth[] }>): RoleCapacity {
  const spent = profiles.map(profile => ({ profile, accounts: health[profile.name]?.accounts ?? [], available: health[profile.name]?.available !== false }));
  const exhausted = spent.length > 0 && spent.every(entry => !entry.available && entry.accounts.length > 0 && entry.accounts.every(account => account.quota === 'exhausted'));
  // Profiles the registry decides share its accounts; each account is named once.
  const accounts: CapacityAccount[] = exhausted ? spent.flatMap(entry => entry.accounts.map(account => ({ account: account.environment, profile: entry.profile.name, resetsAt: account.resetsAt, reason: (account.reason ?? 'quota exhausted').slice(0, 500) })))
    .filter((account, index, all) => all.findIndex(other => other.account === account.account) === index) : [];
  return { role, exhausted, accounts, retryAt: capacityRetryAt(accounts) };
}

/**
 * Onboarding for agent environments: discover the per-account homes (or create new ones), report
 * which are logged in and how much quota each has left, and generate the master's worker, reviewer
 * and producer profiles from the logged-in ones — no hand-written profile JSON.
 *
 * Every launch profile runs on the logged-in accounts, its own runtime's first, rotated so the
 * profiles spread across accounts. Worker and producer principals come from the credential files
 * the operator issued beside the coordinator's (workers/*.token, producers/*.token), each verified
 * against the control plane for its role before a profile uses it. One reviewer profile is
 * generated per logged-in account. Without apply nothing is written; the report is the plan.
 */
export async function setupAgentEnvironments(root: string, input: { directory?: string; create?: EnvironmentKind[]; apply?: boolean; probe?: EnvironmentProbe; verify: (token: string) => Promise<any>; registry?: () => Promise<{ accounts: { name: string }[] }> }) {
  const config = await loadStoredMasterConfig(root);
  const directory = agentEnvironmentRoot(input.directory);
  const discovered = await discoverAgentEnvironments(directory);
  const created: string[] = [];
  for (const kind of input.create ?? []) {
    if (!input.apply) { created.push(`${kind} (a new ${kind}-<letter> directory under ${directory}; rerun with --apply)`); continue; }
    const environment = await createAgentEnvironment(directory, kind, discovered);
    discovered.push(environment); created.push(environment.name);
  }
  const prepared = input.apply ? (await Promise.all(discovered.map(environment => prepareAgentEnvironment(environment)))).flat() : [];
  const probe = { ...input.probe, ceilingPercent: input.probe?.ceilingPercent ?? config.run.quotaCeilingPercent };
  const health = await Promise.all(discovered.map(environment => checkAgentEnvironment(environment, probe)));
  const loggedIn = discovered.filter((_, index) => health[index].loggedIn);
  // GY-3242: once the control plane's registry holds accounts, a profile names only those; an
  // account removed from it (master registry account remove) leaves every profile below.
  const registered = new Set(input.registry ? (await input.registry()).accounts.map(account => account.name) : []);
  const known = (name: string) => !registered.size || registered.has(name);
  const usable = loggedIn.filter(entry => known(entry.name));

  const next: MasterConfig = JSON.parse(JSON.stringify(config));
  next.environments = [...(config.environments ?? []).filter(existing => !discovered.some(found => found.name === existing.name)), ...discovered].sort((a, b) => a.name.localeCompare(b.name));
  // Same-runtime accounts first (the profile's own arguments apply to them), each list rotated so
  // consecutive profiles start on different accounts; the profile's current home, if it is one, leads.
  const accountsFor = (kind: string | undefined, index: number, home?: string) => {
    const rotate = (list: AgentEnvironment[]) => { if (!list.length) return list; const first = home ? list.findIndex(entry => entry.home === home) : -1; const start = first >= 0 ? first : index % list.length; return [...list.slice(start), ...list.slice(0, start)]; };
    return [...rotate(usable.filter(entry => entry.kind === kind)), ...rotate(usable.filter(entry => entry.kind !== kind))].map(entry => entry.name);
  };
  const same = (a?: string[], b?: string[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  const changes: { role: LaunchRole; profile: string; action: 'added' | 'accounts' | 'removed'; accounts: string[]; dropped?: string[]; principal?: string }[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const agentNames = () => new Set([...next.workers, ...next.reviewers, ...next.producers].map(profile => profile.agentName));
  // A profile whose runtime has no environment support keeps launching exactly as configured.
  const supported = (kind?: string) => (environmentKinds as readonly string[]).includes(kind ?? '');
  const migrate = <P extends { name: string; kind?: string; environment: Record<string, string>; accounts?: string[] }>(role: LaunchRole, profile: P, index: number) => {
    if (!supported(profile.kind)) return;
    const variable = environmentVariable[profile.kind as EnvironmentKind];
    const generated = accountsFor(profile.kind, index, profile.environment[variable]);
    // An order already chosen is kept; accounts logged in since are appended to it.
    const accounts = profile.accounts?.length ? [...profile.accounts, ...generated.filter(name => !profile.accounts!.includes(name))] : generated;
    if (!accounts.length || same(profile.accounts, accounts)) return;
    // The account now supplies the home the profile used to pin by hand.
    if (profile.environment[variable] && loggedIn.some(entry => entry.home === profile.environment[variable])) delete profile.environment[variable];
    profile.accounts = accounts; changes.push({ role, profile: profile.name, action: 'accounts', accounts });
  };

  // A profile loses the accounts the registry no longer holds; one left with none is deleted.
  const prune = <P extends { name: string; accounts?: string[] }>(role: LaunchRole, profiles: P[]) => profiles.filter(profile => {
    const dropped = (profile.accounts ?? []).filter(name => !known(name));
    if (!dropped.length) return true;
    const accounts = profile.accounts!.filter(known);
    changes.push({ role, profile: profile.name, action: accounts.length ? 'accounts' : 'removed', accounts, dropped });
    if (accounts.length) profile.accounts = accounts;
    return accounts.length > 0;
  });
  next.workers = prune('worker', next.workers); next.reviewers = prune('reviewer', next.reviewers); next.producers = prune('producer', next.producers);
  if (next.run.reviewerProfile && !next.reviewers.some(profile => profile.name === next.run.reviewerProfile)) delete next.run.reviewerProfile;

  if (usable.length) {
    next.workers.filter(profile => profile.mode === 'launch').forEach((profile, index) => migrate('worker', profile, index));
    next.producers.forEach((profile, index) => migrate('producer', profile, index));
    next.reviewers.forEach((profile, index) => migrate('reviewer', profile, index));
    // Worker and producer credentials are per install (GY-1885): they are read only from the
    // directory `graphyard install` manages for this repository, so a second install on one host
    // never scans — and never refuses — another install's token folder. A master configured with
    // no install of its own (no install.json) keeps reading beside its coordinator credential, as
    // it always has; an install record that exists but cannot be read fails here, never falling
    // back to the host-wide folder another install fills.
    const own = (() => { try { return installDirectory(installIdFor(config.repository)); } catch { return null; } })();
    const installed = own ? await readInstallRecord(own) : null;
    const credentialHome = installed ? own! : dirname(dirname(config.credentialFile));
    const issued = async (role: 'worker' | 'producer') => {
      const folder = resolve(credentialHome, `${role}s`);
      const files = (await readdir(folder).catch(() => [] as string[])).filter(name => name.endsWith('.token')).sort().map(name => resolve(folder, name));
      const found: { file: string; principal: string }[] = [];
      for (const file of files) {
        if ([...next.workers, ...next.producers].some(profile => profile.credentialFile === file)) continue;
        try {
          await externalCredential(root, file, role === 'worker' ? 'Worker' : 'Producer');
          const status = await input.verify(await readCredentialFile(file));
          if (status.actor?.role !== role || typeof status.actor.id !== 'string') { skipped.push({ file, reason: `authenticates ${status.actor?.role ?? 'no'} role, not ${role}` }); continue; }
          found.push({ file, principal: status.actor.id });
        } catch (error) { skipped.push({ file, reason: error instanceof Error ? error.message : 'unreadable credential' }); }
      }
      return found;
    };
    const profileNameOf = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 80) || 'agent';
    // A profile name is Graphyard's own label, in its own syntax; the session name onboarding
    // generates beside it is what Herdr is asked to launch, so it is built inside the runtime's
    // naming rules (GY-101) rather than taken from the label and refused at the first launch.
    const agentNameOf = (name: string) => sessionName(name);
    for (const { file, principal } of await issued('worker')) {
      const name = profileNameOf(principal);
      if (next.workers.some(profile => profile.principal === principal || profile.name === name) || agentNames().has(agentNameOf(name))) { skipped.push({ file, reason: `a profile already uses principal or name ${principal}` }); continue; }
      const index = next.workers.filter(profile => profile.mode === 'launch').length, accounts = accountsFor(undefined, index);
      const kind = next.environments.find(entry => entry.name === accounts[0])!.kind;
      next.workers.push(workerProfileSchema.parse({ name, principal, agentName: agentNameOf(name), mode: 'launch', kind, credentialFile: file, accounts: accountsFor(kind, index) }));
      changes.push({ role: 'worker', profile: name, action: 'added', accounts: accountsFor(kind, index), principal });
    }
    for (const { file, principal } of await issued('producer')) {
      const name = profileNameOf(`produce-${principal}`);
      if (next.workers.some(profile => profile.principal === principal)) { skipped.push({ file, reason: `${principal} is also a worker principal; the control plane refuses evidence from an implementer` }); continue; }
      if (next.producers.some(profile => profile.principal === principal || profile.name === name) || agentNames().has(agentNameOf(name))) { skipped.push({ file, reason: `a profile already uses principal or name ${principal}` }); continue; }
      const index = next.producers.length, accounts = accountsFor(undefined, index);
      const kind = next.environments.find(entry => entry.name === accounts[0])!.kind;
      next.producers.push(producerProfileSchema.parse({ name, principal, agentName: agentNameOf(name), kind, credentialFile: file, accounts: accountsFor(kind, index) }));
      changes.push({ role: 'producer', profile: name, action: 'added', accounts: accountsFor(kind, index), principal });
    }
    for (const environment of usable) {
      const name = profileNameOf(`review-${environment.name}`);
      if (next.reviewers.some(profile => profile.name === name) || agentNames().has(agentNameOf(name))) continue;
      const accounts = [environment.name, ...accountsFor(environment.kind, 0).filter(entry => entry !== environment.name)];
      next.reviewers.push(reviewerProfileSchema.parse({ name, agentName: agentNameOf(name), kind: environment.kind, accounts }));
      changes.push({ role: 'reviewer', profile: name, action: 'added', accounts });
    }
    // Automatic review answers with one profile and fails over to the rest.
    if (next.reviewers.length > 1 && !next.run.reviewerProfile) next.run.reviewerProfile = next.reviewers[0].name;
  }
  const parsed = masterConfigSchema.parse(next);
  if (input.apply) await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), parsed);
  const report = health.map(entry => ({ environment: entry.name, kind: entry.kind, home: entry.home, variable: entry.variable, loggedIn: entry.loggedIn, quota: entry.quota, usage: entry.usage, healthy: entry.healthy, reason: entry.reason, note: entry.note, login: entry.login }));
  const loggedOut = report.filter(entry => !entry.loggedIn);
  return { directory, applied: !!input.apply, environments: report, created, prepared, profiles: changes, skipped,
    counts: { environments: report.length, loggedIn: loggedIn.length, workers: parsed.workers.length, reviewers: parsed.reviewers.length, producers: parsed.producers.length },
    next: !report.length ? `No agent environments under ${directory}; rerun with --create claude (or codex, opencode, cursor) --apply, then log each one in`
      : !loggedIn.length ? `No environment is logged in; log in with: ${loggedOut.map(entry => entry.login).join(' ; ')}, then rerun master environments --apply`
      : !input.apply ? 'Rerun with --apply to write these environments and profiles to .graphyard/master.json'
      : loggedOut.length ? `Profiles use the ${loggedIn.length} logged-in environment(s). Log in the rest (${loggedOut.map(entry => entry.login).join(' ; ')}) and rerun master environments --apply to add them`
      : 'Every environment is logged in and every profile uses it; master run checks login and quota before each launch and fails over between them' };
}

