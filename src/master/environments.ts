// Concern: agent environments and accounts — discovery, health, quota, selection and the launch plan.
import { existsSync } from 'node:fs';
import { readdir, stat, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { defaultChildRun } from '../child-runner.js';
import { sessionName } from '../session-name.js';
import { launchPlan, assertNoApprovalOptOut, LaunchRefusedError } from '../harness.js';
import { type CapacityRole, type CapacityAccount, capacityRetryAt } from '../model/capacity.js';
import { type FleetLaunchAccount, type FleetProbe, selectFleetSession, fleetRoleHealth } from '../fleet.js';
import { type AgentEnvironment, agentEnvironmentSchema, type EnvironmentKind, environmentKinds, environmentVariable, type MasterConfig, masterConfigSchema, producerProfileSchema, reviewerProfileSchema, workerProfileSchema } from './profiles.js';
import { atomicPrivateText, atomicPrivateWrite, externalCredential, loadMasterConfig, readCredentialFile } from './config.js';
import { failureText } from './worktrees.js';
import { shellQuote } from './dispatch.js';

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
    opencode: `XDG_DATA_HOME=${home} opencode auth login`, cursor: `CURSOR_CONFIG_DIR=${home} cursor-agent login` }[environment.kind];
}

export interface AccountUsage { window: string; percent: number; resetsAt: string | null }
export interface EnvironmentHealth {
  name: string; kind: EnvironmentKind; home: string; variable: string; checkedAt: string;
  loggedIn: boolean; quota: 'available' | 'exhausted' | 'unknown'; usage: AccountUsage[];
  /** Launchable: logged in and not exhausted. Unknown quota is launchable; the runtime reports its own limit. */
  healthy: boolean; reason: string | null; note: string | null; login: string | null;
}
export interface EnvironmentProbe {
  fetch?: typeof fetch; now?: () => number; ceilingPercent?: number; timeoutMs?: number; cacheMs?: number;
  /** false reads only the login, never the provider: for reports that must not reach the network. */
  quota?: boolean;
}
export const defaultQuotaCeilingPercent = 95;
const healthCache = new Map<string, { at: number; health: EnvironmentHealth }>();

async function readJsonFile(file: string): Promise<any> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}
const windowName = (minutes: number) => minutes >= 1440 && minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

// Claude Code keeps its subscription login in the environment's .credentials.json. The usage the
// provider meters against it is read from the same endpoint Claude Code's /usage reads; the token
// is sent only to its own provider and never leaves this function.
async function claudeAccount(environment: AgentEnvironment, probe: EnvironmentProbe, now: number) {
  const oauth = (await readJsonFile(resolve(environment.home, '.credentials.json')))?.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object' || !(oauth.accessToken || oauth.refreshToken)) return { loggedIn: false, usage: [], note: null };
  if (probe.quota === false) return { loggedIn: true, usage: [], note: 'quota not read' };
  if (typeof oauth.accessToken !== 'string' || typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now) return { loggedIn: true, usage: [], note: 'the stored access token has expired; Claude Code refreshes it at launch, so quota is read on the next check' };
  try {
    const response = await (probe.fetch ?? fetch)('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(probe.timeoutMs ?? 5_000) });
    if (!response.ok) return { loggedIn: response.status !== 401 || !!oauth.refreshToken, usage: [], note: `the provider usage endpoint answered ${response.status}` };
    const body: any = await response.json();
    const usage = (['five_hour', 'seven_day'] as const).flatMap(key => typeof body?.[key]?.utilization === 'number'
      ? [{ window: key === 'five_hour' ? '5h' : '7d', percent: body[key].utilization, resetsAt: typeof body[key].resets_at === 'string' ? new Date(body[key].resets_at).toISOString() : null }] : []);
    return { loggedIn: true, usage, note: null };
  } catch (error) { return { loggedIn: true, usage: [], note: `the provider usage endpoint is unreachable: ${error instanceof Error ? error.message : 'unknown reason'}` }; }
}

// Codex records the provider's rate-limit windows in every session it writes; the newest record
// is the account's last reported usage.
async function newestCodexRateLimits(home: string) {
  const directories = async (directory: string) => { try { return (await readdir(directory)).filter(name => /^\d+$/.test(name)).sort().reverse().map(name => resolve(directory, name)); } catch { return []; } };
  const files: { file: string; modified: number }[] = [];
  for (const year of await directories(resolve(home, 'sessions'))) {
    for (const month of await directories(year)) {
      for (const day of await directories(month)) {
        for (const name of (await readdir(day).catch(() => [] as string[])).filter(entry => entry.endsWith('.jsonl'))) {
          const file = resolve(day, name);
          try { files.push({ file, modified: (await stat(file)).mtimeMs }); } catch { /* removed while listing */ }
        }
        if (files.length >= 5) break;
      }
      if (files.length >= 5) break;
    }
    if (files.length >= 5) break;
  }
  for (const { file } of files.sort((a, b) => b.modified - a.modified).slice(0, 5)) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const line of text.slice(-1_000_000).split('\n').reverse()) {
      if (!line.includes('"rate_limits"')) continue;
      let record: any; try { record = JSON.parse(line); } catch { continue; }
      const limits = record?.payload?.rate_limits ?? record?.payload?.info?.rate_limits ?? record?.rate_limits;
      if (limits && (limits.primary || limits.secondary)) return limits;
    }
  }
  return null;
}
async function codexAccount(environment: AgentEnvironment, probe: EnvironmentProbe) {
  const auth = await readJsonFile(resolve(environment.home, 'auth.json'));
  const loggedIn = !!auth && (typeof auth.tokens?.access_token === 'string' || typeof auth.OPENAI_API_KEY === 'string' && !!auth.OPENAI_API_KEY);
  if (!loggedIn || probe.quota === false) return { loggedIn, usage: [], note: loggedIn ? 'quota not read' : null, reached: false };
  const limits = await newestCodexRateLimits(environment.home);
  if (!limits) return { loggedIn, usage: [], note: 'no Codex session has reported rate limits for this account yet', reached: false };
  const usage = [limits.primary, limits.secondary].filter(window => window && typeof window.used_percent === 'number').map((window: any) => ({
    window: typeof window.window_minutes === 'number' ? windowName(window.window_minutes) : 'window', percent: window.used_percent,
    resetsAt: typeof window.resets_at === 'number' ? new Date(window.resets_at * 1000).toISOString() : null }));
  return { loggedIn, usage, note: null, reached: !!limits.rate_limit_reached_type };
}

export async function checkAgentEnvironment(environment: AgentEnvironment, probe: EnvironmentProbe = {}): Promise<EnvironmentHealth> {
  const now = probe.now?.() ?? Date.now(), ceiling = probe.ceilingPercent ?? defaultQuotaCeilingPercent;
  const cacheKey = `${environment.name}\0${environment.home}\0${ceiling}\0${probe.quota !== false}`, cached = healthCache.get(cacheKey);
  if (cached && now - cached.at >= 0 && now - cached.at < (probe.cacheMs ?? 30_000)) return cached.health;
  const account: { loggedIn: boolean; usage: AccountUsage[]; note: string | null; reached?: boolean } = environment.kind === 'claude' ? await claudeAccount(environment, probe, now)
    : environment.kind === 'codex' ? await codexAccount(environment, probe)
    : environment.kind === 'opencode' ? { loggedIn: Object.keys((await readJsonFile(resolve(environment.home, 'opencode/auth.json'))) ?? {}).length > 0, usage: [], note: 'OpenCode exposes no provider quota Graphyard can read; its providers report their own limits in the session' }
    : { loggedIn: (candidate => !!candidate && !!(candidate.userId || candidate.email))((await readJsonFile(resolve(environment.home, 'cli-config.json')))?.authInfo), usage: [], note: 'Cursor exposes no quota Graphyard can read; the session reports its own limit' };
  const future = (usage: AccountUsage) => !usage.resetsAt || Date.parse(usage.resetsAt) > now;
  const spent = account.usage.filter(usage => usage.percent >= ceiling && future(usage));
  const exhausted = spent.length > 0 || !!account.reached && account.usage.some(future);
  const quota = !account.loggedIn ? 'unknown' as const : exhausted ? 'exhausted' as const : account.usage.length ? 'available' as const : 'unknown' as const;
  const reason = !account.loggedIn ? `${environment.name} is not logged in`
    : exhausted ? `${environment.name} quota is exhausted (${(spent.length ? spent : account.usage).map(usage => `${usage.window} window at ${usage.percent}%${usage.resetsAt ? ` until ${usage.resetsAt}` : ''}`).join(', ')}; ceiling ${ceiling}%)` : null;
  const health: EnvironmentHealth = { name: environment.name, kind: environment.kind, home: environment.home, variable: environmentVariable[environment.kind], checkedAt: new Date(now).toISOString(),
    loggedIn: account.loggedIn, quota, usage: account.usage, healthy: !reason, reason, note: account.note, login: account.loggedIn ? null : loginCommand(environment) };
  healthCache.set(cacheKey, { at: now, health });
  return health;
}

export type LaunchRole = 'worker' | 'reviewer' | 'producer';
/**
 * Why a launch passed an account over. Only `exhausted` — a quota read as spent, or one a session
 * itself reported — is the provider's capacity and waits for a reset. A logged-out account or a
 * name that is not a configured environment is something a master fixes in one command, so it must
 * keep reading as a launch that went wrong rather than as a wait (GY-89).
 */
export type AccountSkipCause = 'exhausted' | 'logged-out' | 'unconfigured';
export interface AccountSkip { at: string; role: LaunchRole; profile: string; environment: string; reason: string; work: string | null; cause: AccountSkipCause }
/** Every account of a profile was skipped: the caller fails over to its next profile, or reports the skips. */
export class NoHealthyAccountError extends Error {
  /** Fail over to the next profile: true for every reason an account was passed over. */
  readonly accountsExhausted = true;
  /** This profile has no capacity left: true only when every account it skipped was spent. */
  readonly capacityExhausted: boolean;
  constructor(message: string, readonly skipped: AccountSkip[]) {
    super(message);
    this.capacityExhausted = skipped.length > 0 && skipped.every(skip => skip.cause === 'exhausted');
  }
}

// What the launch loop last observed about each environment, and the recent launches it skipped
// away from and why, kept beside the coordinator's other private state so master status can say it.
const environmentLogSchema = z.object({
  version: z.literal(1),
  environments: z.record(z.string(), z.any()).default({}),
  skipped: z.array(z.object({ at: z.string(), role: z.enum(['worker', 'reviewer', 'producer']), profile: z.string(), environment: z.string(), reason: z.string().max(500), work: z.string().nullable(),
    // Logs written before GY-89 carry no cause; they read as the exhaustion the flag then meant.
    cause: z.enum(['exhausted', 'logged-out', 'unconfigured']).default('exhausted') }).strict()).max(50).default([]),
  // Accounts a session exhausted mid-work (GY-89), by environment name, each held until its reset.
  // The account each profile's latest launch selected, by `role:profile`, so an exhausted session can be traced to its account.
  selected: z.record(z.string(), z.object({ environment: z.string().nullable(), kind: z.string().nullable(), at: z.string(), work: z.string().nullable() }).strict()).default({}),
  exhausted: z.record(z.string(), z.object({ at: z.string(), until: z.string(), resetsAt: z.string().nullable(), reason: z.string().max(500), role: z.enum(['worker', 'reviewer', 'producer']), profile: z.string(), work: z.string().nullable() }).strict()).default({}),
}).strict();
/**
 * An account a running session exhausted. The provider's own usage endpoint may lag behind the
 * session that hit the limit, and OpenCode and Cursor expose no quota to read at all, so what a
 * session printed is kept here and every launch skips the account until `until`: the reset time
 * the notice named, or an hour when it named none.
 */
export interface ObservedExhaustion { at: string; until: string; resetsAt: string | null; reason: string; role: LaunchRole; profile: string; work: string | null }
export const unknownResetHoldMs = 3_600_000;
export interface AccountSelection { environment: string | null; kind: string | null; at: string; work: string | null }
export type EnvironmentLog = { version: 1; environments: Record<string, EnvironmentHealth>; skipped: AccountSkip[]; selected: Record<string, AccountSelection>; exhausted: Record<string, ObservedExhaustion> };
/** A profile that names no accounts launches on whatever its own environment selects; its exhaustion is held under this name. */
export const profileAccount = (profile: string) => `profile:${profile}`;
export const selectionKey = (role: LaunchRole, profile: string) => `${role}:${profile}`;
export function environmentLogPath(config: Pick<MasterConfig, 'credentialFile'>) {
  return resolve(dirname(config.credentialFile), `${basename(config.credentialFile).replace(/\.token$/, '')}.environments.json`);
}
export async function readEnvironmentLog(config: Pick<MasterConfig, 'credentialFile'>): Promise<EnvironmentLog> {
  try { return environmentLogSchema.parse(JSON.parse(await readFile(environmentLogPath(config), 'utf8'))) as EnvironmentLog; }
  catch { return { version: 1, environments: {}, skipped: [], selected: {}, exhausted: {} }; }
}
/** Record that a session exhausted `environment` mid-work, so no launch selects it before it resets. */
export async function recordObservedExhaustion(config: Pick<MasterConfig, 'credentialFile'>, environment: string, observed: Omit<ObservedExhaustion, 'until'>, now = Date.now()) {
  const log = await readEnvironmentLog(config);
  const reset = observed.resetsAt ? Date.parse(observed.resetsAt) : Number.NaN;
  const entry: ObservedExhaustion = { ...observed, reason: observed.reason.slice(0, 500), until: new Date(Number.isFinite(reset) && reset > now ? reset : now + unknownResetHoldMs).toISOString() };
  log.exhausted = { ...Object.fromEntries(Object.entries(log.exhausted).filter(([, held]) => Date.parse(held.until) > now)), [environment]: entry };
  await atomicPrivateWrite(environmentLogPath(config), log);
  return entry;
}
/** The accounts still held by an observed exhaustion at `now`. */
export async function observedExhaustions(config: Pick<MasterConfig, 'credentialFile'>, now = Date.now()): Promise<Record<string, ObservedExhaustion>> {
  const log = await readEnvironmentLog(config);
  return Object.fromEntries(Object.entries(log.exhausted ?? {}).filter(([, held]) => Date.parse(held.until) > now));
}
export const describeObservedExhaustion = (environment: string, held: ObservedExhaustion) =>
  `${environment} exhausted its quota mid-session at ${held.at} (${held.reason}); ${held.resetsAt ? `it resets ${held.resetsAt}` : `its reset time is unknown, so it is tried again after ${held.until}`}`;
export async function recordEnvironmentLog(config: Pick<MasterConfig, 'credentialFile'>, health: EnvironmentHealth[], skipped: AccountSkip[] = [], selection?: { key: string } & AccountSelection) {
  if (!health.length && !skipped.length && !selection) return;
  const log = await readEnvironmentLog(config);
  if (selection) { const { key, ...selected } = selection; log.selected = { ...log.selected, [key]: selected }; }
  for (const entry of health) log.environments[entry.name] = entry;
  log.skipped = [...log.skipped, ...skipped.map(entry => ({ ...entry, reason: entry.reason.slice(0, 500) }))].slice(-50);
  await atomicPrivateWrite(environmentLogPath(config), log);
}

/**
 * The account a launch runs on: the first of the profile's accounts that is logged in with quota
 * left. Every account passed over is recorded with its reason. A profile that names no accounts
 * launches exactly as configured, on whatever its environment variables select.
 *
 * When the control plane's agent registry defines the role, the registry decides instead: the
 * control plane chooses the first eligible account of the role — placed on this host, logged in,
 * within quota, under its session and concurrency limits — and records the choice and its reason
 * (see fleet.ts). The profile then supplies only the Graphyard identity the session acts under.
 * A role the registry does not define yet launches from the profile's own accounts, as before.
 */
export type LaunchAccount = AgentEnvironment | FleetLaunchAccount;
export interface LaunchSelection { account: LaunchAccount | null; health: EnvironmentHealth | null; skipped: AccountSkip[]; /** Gives a registry session back when the launch it was chosen for failed. */ release?: (reason: string) => Promise<void> }
export async function selectAccount(config: Pick<MasterConfig, 'environments' | 'credentialFile' | 'run'> & Partial<Pick<MasterConfig, 'url' | 'hostId'>>, role: LaunchRole, profile: { name: string; accounts?: string[]; principal?: string }, probe: FleetProbe = {}): Promise<LaunchSelection> {
  const fleet = await selectFleetSession(config, role, profile, probe);
  if (fleet) {
    await recordEnvironmentLog(config, fleet.health ? [fleet.health] : [], fleet.skipped).catch(() => {});
    return fleet;
  }
  const at = new Date(probe.now?.() ?? Date.now()).toISOString();
  const checked: EnvironmentHealth[] = [], skipped: AccountSkip[] = [];
  const held = await observedExhaustions(config, probe.now?.() ?? Date.now());
  if (!profile.accounts?.length) {
    const own = held[profileAccount(profile.name)];
    if (own) {
      const skip: AccountSkip = { at, role, profile: profile.name, environment: profileAccount(profile.name), reason: describeObservedExhaustion(`${profile.name}'s own account`, own), work: probe.work ?? null, cause: 'exhausted' };
      await recordEnvironmentLog(config, [], [skip]).catch(() => {});
      throw new NoHealthyAccountError(`No healthy agent account for ${role} profile ${profile.name}: ${skip.reason}`, [skip]);
    }
    await recordEnvironmentLog(config, [], [], { key: selectionKey(role, profile.name), environment: null, kind: null, at, work: probe.work ?? null }).catch(() => {});
    return { account: null, health: null, skipped: [] as AccountSkip[] };
  }
  for (const name of profile.accounts) {
    const environment = (config.environments ?? []).find(candidate => candidate.name === name);
    if (!environment) { skipped.push({ at, role, profile: profile.name, environment: name, reason: `${name} is not a configured agent environment; run master environments --apply`, work: probe.work ?? null, cause: 'unconfigured' }); continue; }
    // What a session itself reported outranks the provider's usage read, which may lag or not exist.
    if (held[name]) { skipped.push({ at, role, profile: profile.name, environment: name, reason: describeObservedExhaustion(name, held[name]), work: probe.work ?? null, cause: 'exhausted' }); continue; }
    const health = await checkAgentEnvironment(environment, { ...probe, ceilingPercent: probe.ceilingPercent ?? config.run.quotaCeilingPercent });
    checked.push(health);
    if (health.healthy) {
      await recordEnvironmentLog(config, checked, skipped, { key: selectionKey(role, profile.name), environment: environment.name, kind: environment.kind, at, work: probe.work ?? null }).catch(() => {});
      return { account: environment, health, skipped };
    }
    // `checkAgentEnvironment` reports exactly two faults: not logged in, or quota spent.
    skipped.push({ at, role, profile: profile.name, environment: name, reason: health.reason!, work: probe.work ?? null, cause: health.loggedIn ? 'exhausted' : 'logged-out' });
  }
  await recordEnvironmentLog(config, checked, skipped).catch(() => {});
  throw new NoHealthyAccountError(`No healthy agent account for ${role} profile ${profile.name}: ${skipped.map(entry => entry.reason).join('; ')}`, skipped);
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
 * An operator's own OpenCode permission document that asks nothing (the recipe's `permits`) is laid
 * over the allow-all rather than replacing it: a key it leaves out (`external_directory`,
 * `doom_loop`, …) keeps Graphyard's `allow` instead of falling back to OpenCode's default, which asks.
 */
function openCodePermission(operator: string | undefined) {
  if (operator === undefined) return JSON.stringify(openCodeAllowAll);
  const document: unknown = JSON.parse(operator);
  return document && typeof document === 'object' && !Array.isArray(document) ? JSON.stringify({ ...openCodeAllowAll, ...document }) : operator;
}
export function agentLaunchPlan(kind: string | undefined, approvals: 'auto' | 'prompt' = 'auto', agentArgs: string[] = [], environment: Record<string, string> = {}) {
  const plan = launchPlan(kind, approvals, agentArgs, environment);
  if (!plan.applied || kind !== 'opencode') return plan;
  return { ...plan, environment: { ...plan.environment, OPENCODE_PERMISSION: openCodePermission(environment.OPENCODE_PERMISSION) }, prompts: 'every permission prompt, including edits, shell commands, fetches, and paths outside the worktree',
    tradeoff: 'opencode edits files, runs shell commands, fetches URLs, and reaches outside its worktree without asking.' };
}

/**
 * What a session launches with once its account is chosen: the account's kind and home, the
 * profile's arguments when they belong to that runtime, and the runtime's broadest approval mode.
 * Codex keeps its workspace sandbox, so the paths and network access the role needs are added to it:
 * a worker commits into the repository's shared Git directory and pushes; a producer builds in a
 * detached worktree under the managed worktree root, and is given its own session directory there
 * and nothing beside it.
 */
export function accountLaunch(profile: { kind?: string; approvals: 'auto' | 'prompt'; agentArgs: string[]; environment: Record<string, string> }, account: LaunchAccount | null, reach: { writable?: string[] } = {}) {
  // A registry account carries its runtime's launch contract: what to start, its own startup
  // arguments, the variable that selects the login home, and the flag that selects its model.
  const contract = account && 'fleet' in account ? account.fleet.contract : null;
  const kind = account?.kind ?? profile.kind;
  const own = !account || account.kind === profile.kind ? profile.agentArgs : [];
  const model = contract?.modelFlag && account && 'fleet' in account && account.fleet.modelId && !own.includes(contract.modelFlag) && !contract.args.includes(contract.modelFlag) ? [contract.modelFlag, account.fleet.modelId] : [];
  // An approvals opt-out is refused, naming the runtime, before any session starts (GY-184).
  assertNoApprovalOptOut(kind ?? 'unnamed', profile.approvals);
  const plan = agentLaunchPlan(kind, profile.approvals, [...(contract?.args ?? []), ...model, ...own], { ...contract?.environment, ...profile.environment });
  // So is an effective launch whose own arguments or environment still let the runtime ask.
  if (plan.refusal) throw new LaunchRefusedError(kind ?? 'unnamed', plan.refusal);
  // The plan's variables come last: they are the recipe's, where the profile set none, or the
  // profile's own OpenCode permissions laid over the allow-all.
  const environment: Record<string, string> = { ...contract?.environment, ...profile.environment, ...plan.environment };
  if (account) {
    // A runtime that names no home variable falls back to its kind's known one, and an account
    // whose home still cannot be applied is refused rather than started on the default login (GY-180).
    const variable = contract?.homeVariable ?? (Object.hasOwn(environmentVariable, account.kind) ? environmentVariable[account.kind as EnvironmentKind] : null);
    if (!variable && account.home) throw new LaunchRefusedError(account.kind, `Graphyard refuses to launch account ${account.name}: its home ${account.home} cannot be applied because ${contract && 'fleet' in account ? `runtime ${account.fleet.runtime}` : 'its environment'} names no login-home variable and the ${account.kind} kind has none known, so the session would run on the default login instead of ${account.name}. Set the runtime's home variable with master registry runtime set NAME --home-variable VAR.`);
    if (variable && account.home) environment[variable] = account.home;
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
export async function inspectProfileAccounts<T extends { available: boolean; reason: string | null }>(config: Pick<MasterConfig, 'environments' | 'credentialFile' | 'run'> & Partial<Pick<MasterConfig, 'url' | 'hostId'>>, role: LaunchRole, profiles: { name: string; accounts?: string[] }[], health: Record<string, T>, probe: EnvironmentProbe = {}) {
  const result: Record<string, T & { accounts?: ProfileAccountHealth[] }> = { ...health };
  const now = probe.now?.() ?? Date.now(), held = await observedExhaustions(config, now);
  // A role the agent registry defines is judged from the registry: every profile of the role
  // launches on the same ordered accounts, so they share one answer.
  const fleet = await fleetRoleHealth(config, role, probe).catch(() => null);
  for (const profile of profiles) {
    if (fleet) {
      if (result[profile.name]?.available !== false) result[profile.name] = { ...(result[profile.name] ?? { available: true, reason: null } as T), available: fleet.available, reason: fleet.reason, accounts: fleet.accounts };
      continue;
    }
    if (result[profile.name]?.available === false) continue;
    if (!profile.accounts?.length) {
      const own = held[profileAccount(profile.name)];
      if (own) result[profile.name] = { ...(result[profile.name] ?? { available: true, reason: null } as T), available: false, reason: `No healthy agent account: ${describeObservedExhaustion(`${profile.name}'s own account`, own)}`,
        accounts: [{ environment: profileAccount(profile.name), healthy: false, reason: describeObservedExhaustion(`${profile.name}'s own account`, own), quota: 'exhausted', resetsAt: own.resetsAt }] };
      continue;
    }
    const accounts: ProfileAccountHealth[] = [];
    for (const name of profile.accounts) {
      const environment = (config.environments ?? []).find(candidate => candidate.name === name);
      if (!environment) { accounts.push({ environment: name, healthy: false, reason: `${name} is not a configured agent environment`, quota: 'unknown', resetsAt: null }); continue; }
      if (held[name]) { accounts.push({ environment: name, healthy: false, reason: describeObservedExhaustion(name, held[name]), quota: 'exhausted', resetsAt: held[name].resetsAt }); continue; }
      const checked = await checkAgentEnvironment(environment, { ...probe, ceilingPercent: probe.ceilingPercent ?? config.run.quotaCeilingPercent });
      // The reset that matters is the latest among the spent windows: the account launches again only when all of them have.
      const ceiling = probe.ceilingPercent ?? config.run.quotaCeilingPercent ?? defaultQuotaCeilingPercent;
      const resets = checked.quota === 'exhausted' ? checked.usage.filter(usage => usage.percent >= ceiling).map(usage => usage.resetsAt ? Date.parse(usage.resetsAt) : Number.NaN).filter(value => Number.isFinite(value) && value > now) : [];
      accounts.push({ environment: name, healthy: checked.healthy, reason: checked.reason, quota: checked.quota, resetsAt: resets.length ? new Date(Math.max(...resets)).toISOString() : null });
    }
    const usable = accounts.some(account => account.healthy);
    result[profile.name] = { ...(result[profile.name] ?? { available: true, reason: null } as T), available: usable, reason: usable ? null : `No healthy agent account: ${accounts.map(account => account.reason).join('; ')}`, accounts };
  }
  return result;
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
  const accounts: CapacityAccount[] = exhausted ? spent.flatMap(entry => entry.accounts.map(account => ({ account: account.environment, profile: entry.profile.name, resetsAt: account.resetsAt, reason: (account.reason ?? 'quota exhausted').slice(0, 500) }))) : [];
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
export async function setupAgentEnvironments(root: string, input: { directory?: string; create?: EnvironmentKind[]; apply?: boolean; probe?: EnvironmentProbe; verify: (token: string) => Promise<any> }) {
  const config = await loadMasterConfig(root);
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

  const next: MasterConfig = JSON.parse(JSON.stringify(config));
  next.environments = [...(config.environments ?? []).filter(existing => !discovered.some(found => found.name === existing.name)), ...discovered].sort((a, b) => a.name.localeCompare(b.name));
  // Same-runtime accounts first (the profile's own arguments apply to them), each list rotated so
  // consecutive profiles start on different accounts; the profile's current home, if it is one, leads.
  const accountsFor = (kind: string | undefined, index: number, home?: string) => {
    const rotate = (list: AgentEnvironment[]) => { if (!list.length) return list; const first = home ? list.findIndex(entry => entry.home === home) : -1; const start = first >= 0 ? first : index % list.length; return [...list.slice(start), ...list.slice(0, start)]; };
    return [...rotate(loggedIn.filter(entry => entry.kind === kind)), ...rotate(loggedIn.filter(entry => entry.kind !== kind))].map(entry => entry.name);
  };
  const same = (a?: string[], b?: string[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  const changes: { role: LaunchRole; profile: string; action: 'added' | 'accounts'; accounts: string[]; principal?: string }[] = [];
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

  if (loggedIn.length) {
    next.workers.filter(profile => profile.mode === 'launch').forEach((profile, index) => migrate('worker', profile, index));
    next.producers.forEach((profile, index) => migrate('producer', profile, index));
    next.reviewers.forEach((profile, index) => migrate('reviewer', profile, index));
    const credentialHome = dirname(dirname(config.credentialFile));
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
    for (const environment of loggedIn) {
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
