import { z } from 'zod';
import type { Work } from './work.js';

/**
 * The agent registry: the fleet as control-plane state (GY-91).
 *
 * A *runtime* is an agent CLI and the launch contract every session of it starts with. An
 * *account* is one login of a runtime: it references where the credential lives (a host and a
 * home directory) and never holds the credential, runs one *model*, and carries the quota state
 * executors last observed for it. A *role* names the accounts that may serve it, in preference
 * order, and how many sessions of the role may run at once. Executors ask the control plane for a
 * session when they run an action; the choice — the first eligible account — is made here, inside
 * the coordination transaction, and recorded with its reason. Nothing in this file names a
 * particular runtime or account: the built-in contracts below are what setup *proposes*, and only
 * what the registry stores is ever launched.
 */

const entryName = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/, 'Use letters, digits, dot, underscore or dash (at most 80 characters)');
const hostName = z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'A host id cannot contain control characters');
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed');
// Pure string check, so the dashboard can share this module without a Node import.
const isAbsolute = (value: string) => /^(\/|[A-Za-z]:[\\/])/.test(value);
const secretName = /(TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY|CREDENTIAL)/;
// What a pasted credential looks like: provider key prefixes, a bearer header, a PEM block, a JWT.
const secretValue = /^(sk-|ghp_|gho_|ghs_|github_pat_|xox[abp]-|Bearer\s)|-----BEGIN|^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;
const notSecret = (value: string) => !secretValue.test(value);

const launchEnvironment = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/)
    .refine(name => !name.startsWith('GRAPHYARD_'), 'GRAPHYARD_ variables are owned by the launcher')
    .refine(name => !secretName.test(name), 'A launch contract never carries a secret; the credential lives in the runtime login the account references'),
  z.string().min(1).max(1000).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Environment values cannot contain control characters').refine(notSecret, 'That value looks like a credential; the registry stores references, never secrets'),
).default({});

/**
 * How a session of a runtime is started. `kind` is what the session host launches (Herdr's agent
 * kind, which is the executable). `args` are the runtime's own non-interactive startup arguments,
 * `homeVariable` the variable that points the CLI at one account's login home, `modelFlag` the
 * argument that selects the account's model, `login` the command an operator runs to log an
 * account in (`{home}` stands for the account's home), and `loginFile` a path inside the home
 * whose presence means the account is logged in, for runtimes Graphyard has no richer probe for.
 */
export const launchContractSchema = z.object({
  kind: entryName,
  args: z.array(z.string().max(1000).refine(notSecret, 'That argument looks like a credential; the registry stores references, never secrets')).max(30).default([]),
  environment: launchEnvironment,
  homeVariable: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).refine(name => !name.startsWith('GRAPHYARD_'), 'GRAPHYARD_ variables are owned by the launcher').nullable().default(null),
  modelFlag: z.string().regex(/^--?[a-zA-Z][a-zA-Z0-9-]*$/).nullable().default(null),
  login: z.string().trim().min(1).max(500).refine(notSecret, 'A login command names how to log in, never the credential').nullable().default(null),
  loginFile: z.string().trim().min(1).max(200).refine(value => !isAbsolute(value) && !value.split('/').includes('..'), 'loginFile is a path inside the account home').nullable().default(null),
}).strict();
export type LaunchContract = z.infer<typeof launchContractSchema>;

export const runtimeSchema = z.object({
  name: entryName,
  description: text(300).optional(),
  launch: launchContractSchema,
}).strict();
export type FleetRuntime = z.infer<typeof runtimeSchema>;

export const capabilityTiers = ['frontier', 'strong', 'fast'] as const;
/** A model an account runs: what it costs and what it is good for, so role order can weigh both. */
export const modelSchema = z.object({
  name: entryName,
  provider: text(100).optional(),
  /** The identifier handed to the runtime's model flag; null runs the account's own default. */
  id: z.string().trim().min(1).max(200).refine(notSecret, 'A model id is a name, never a credential').nullable().default(null),
  /** US dollars per million tokens; null when the account is a flat subscription or unknown. */
  cost: z.object({ inputPerMTok: z.number().min(0).max(100_000).nullable().default(null), outputPerMTok: z.number().min(0).max(100_000).nullable().default(null) }).strict().prefault({}),
  capability: z.object({ tier: z.enum(capabilityTiers).default('strong'), contextTokens: z.number().int().min(1000).max(100_000_000).nullable().default(null), notes: text(300).optional() }).strict().prefault({}),
}).strict();
export type FleetModel = z.infer<typeof modelSchema>;

export const quotaStates = ['available', 'exhausted', 'unknown'] as const;
export const usageSchema = z.object({ window: text(40), percent: z.number().min(0).max(1000), resetsAt: z.string().datetime().nullable() }).strict();
/** What was last observed about an account: by an executor's probe on its host, or marked by an operator. */
export const quotaObservationSchema = z.object({
  loggedIn: z.boolean().nullable().default(null),
  state: z.enum(quotaStates).default('unknown'),
  usage: z.array(usageSchema).max(10).default([]),
  resetsAt: z.string().datetime().nullable().default(null),
  reason: text(500).nullable().default(null),
}).strict();
export type QuotaObservation = z.infer<typeof quotaObservationSchema>;
export interface ObservedQuota extends QuotaObservation { observedAt: string | null; observedBy: string | null; source: 'probe' | 'operator' | null }
export const unobservedQuota: ObservedQuota = { loggedIn: null, state: 'unknown', usage: [], resetsAt: null, reason: null, observedAt: null, observedBy: null, source: null };

/**
 * One login of a runtime. The credential is held by reference: the host whose filesystem holds
 * the login and the home directory it lives in (null for a runtime's own default login). That
 * host is also the account's placement — a session can only start where the login is.
 */
export const accountSchema = z.object({
  name: entryName,
  runtime: entryName,
  model: entryName,
  credential: z.object({
    host: hostName,
    home: z.string().min(1).max(500).refine(isAbsolute, 'An account home is an absolute path on its host').refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed').nullable().default(null),
  }).strict(),
  enabled: z.boolean().default(true),
  /** How many sessions may run on this account at once, across every role; null is unbounded. */
  maxSessions: z.number().int().min(1).max(100).nullable().default(null),
  note: text(300).optional(),
}).strict();
export type FleetAccountInput = z.infer<typeof accountSchema>;
export interface FleetAccount extends FleetAccountInput { quota: ObservedQuota }

export const fleetRoles = ['worker', 'reviewer', 'producer', 'approver', 'escalation-handler'] as const;
export type FleetRoleName = typeof fleetRoles[number];
export const roleSchema = z.object({
  name: z.enum(fleetRoles),
  /** Eligible accounts, most preferred first. */
  accounts: z.array(entryName).max(50).refine(list => new Set(list).size === list.length, 'A role lists each account once'),
  /** How many sessions of this role may run at once; 0 pauses the role. */
  concurrency: z.number().int().min(0).max(100),
}).strict();
export type FleetRole = z.infer<typeof roleSchema>;

export interface SessionSkip { account: string; reason: string }
/** One recorded choice: who asked, what was chosen, why, and everything passed over on the way. */
export interface FleetSession {
  id: string; role: FleetRoleName; account: string; runtime: string; model: string;
  host: string; work: string | null; principal: string | null;
  selectedAt: string; selectedBy: string; reason: string; skipped: SessionSkip[];
  endedAt: string | null; endReason: string | null;
}
export interface FleetRefusal { at: string; role: string; host: string; work: string | null; by: string; reason: string; skipped: SessionSkip[] }

export interface AgentRegistry {
  version: 1; revision: number; updatedAt: string | null;
  runtimes: FleetRuntime[]; models: FleetModel[]; accounts: FleetAccount[]; roles: FleetRole[];
  /** Live sessions and the most recently ended ones, bounded; the ledger holds every selection. */
  sessions: FleetSession[];
  refusals: FleetRefusal[];
  lastMutation: { kind: string; actor: string; at: string; reason: string } | null;
}
export const emptyRegistry = (): AgentRegistry => ({ version: 1, revision: 0, updatedAt: null, runtimes: [], models: [], accounts: [], roles: [], sessions: [], refusals: [], lastMutation: null });
export const sessionHistoryLimit = 100, refusalHistoryLimit = 20;

const reason = text(2000);
export const registryMutationSchemas = {
  'runtime.set': z.object({ runtime: runtimeSchema, reason }).strict(),
  'runtime.remove': z.object({ name: entryName, reason }).strict(),
  'model.set': z.object({ model: modelSchema, reason }).strict(),
  'model.remove': z.object({ name: entryName, reason }).strict(),
  'account.set': z.object({ account: accountSchema, reason }).strict(),
  'account.remove': z.object({ name: entryName, reason }).strict(),
  'account.quota': z.object({ name: entryName, quota: quotaObservationSchema, reason }).strict(),
  'role.set': z.object({ role: roleSchema, reason }).strict(),
  'role.remove': z.object({ name: z.enum(fleetRoles), reason }).strict(),
  /** A whole proposal at once, in dependency order: what setup discovers and an operator accepts. */
  apply: z.object({ runtimes: z.array(runtimeSchema).max(50).default([]), models: z.array(modelSchema).max(100).default([]), accounts: z.array(accountSchema).max(200).default([]), roles: z.array(roleSchema).max(fleetRoles.length).default([]), reason }).strict(),
} as const;
export type RegistryMutation = keyof typeof registryMutationSchemas;
export const registryLimits = { runtimes: 50, models: 100, accounts: 200 } as const;

export const selectionRequestSchema = z.object({
  role: z.enum(fleetRoles),
  host: hostName,
  work: z.string().trim().min(1).max(40).nullable().default(null),
  principal: z.string().trim().min(1).max(200).nullable().default(null),
  /** What the executor just observed about the accounts that live on its host. */
  observations: z.array(z.object({ account: entryName, quota: quotaObservationSchema }).strict()).max(200).default([]),
}).strict();
export type SelectionRequest = z.infer<typeof selectionRequestSchema>;

/** How an executor names itself on a read, so placement is judged for it (by header, so an older server ignores it). */
export const executorHostHeader = 'X-Graphyard-Host';
export class RegistryError extends Error {}
const demandRegistry: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new RegistryError(message); };
const upsert = <T extends { name: string }>(list: T[], entry: T) => { const at = list.findIndex(item => item.name === entry.name); if (at < 0) list.push(entry); else list[at] = entry; };

/**
 * Apply one configuration change to a copy of the registry, keeping every reference whole. An
 * account names a runtime and a model that exist; a role names accounts that exist. Removing an
 * account takes it out of every role, and removing a runtime removes its accounts the same way,
 * so the roles that used them fall back to the accounts that remain, in the order they held.
 */
export function applyRegistryMutation(current: AgentRegistry, kind: RegistryMutation, input: unknown, context: { actor: string; at: string }) {
  const next: AgentRegistry = structuredClone(current);
  const removed = { accounts: [] as string[], roles: {} as Record<string, string[]> };
  const dropAccounts = (names: string[]) => {
    for (const name of names) {
      next.accounts = next.accounts.filter(account => account.name !== name); removed.accounts.push(name);
      for (const role of next.roles) if (role.accounts.includes(name)) { role.accounts = role.accounts.filter(entry => entry !== name); (removed.roles[role.name] ??= []).push(name); }
      for (const session of next.sessions) if (session.account === name && !session.endedAt) { session.endedAt = context.at; session.endReason = `account ${name} was removed from the registry`; }
    }
  };
  const setRuntime = (runtime: FleetRuntime) => { upsert(next.runtimes, runtime); demandRegistry(next.runtimes.length <= registryLimits.runtimes, `The registry holds at most ${registryLimits.runtimes} runtimes`); };
  const setModel = (model: FleetModel) => { upsert(next.models, model); demandRegistry(next.models.length <= registryLimits.models, `The registry holds at most ${registryLimits.models} models`); };
  const setAccount = (account: FleetAccountInput) => {
    demandRegistry(next.runtimes.some(runtime => runtime.name === account.runtime), `Unknown runtime ${account.runtime}; add the runtime before its accounts`);
    demandRegistry(next.models.some(model => model.name === account.model), `Unknown model ${account.model}; add the model before the accounts that run it`);
    const existing = next.accounts.find(entry => entry.name === account.name);
    // A login that moved is a different login: what was observed about the old one says nothing about it.
    const sameLogin = existing && existing.runtime === account.runtime && existing.credential.host === account.credential.host && existing.credential.home === account.credential.home;
    upsert(next.accounts, { ...account, quota: sameLogin ? existing.quota : { ...unobservedQuota } });
    demandRegistry(next.accounts.length <= registryLimits.accounts, `The registry holds at most ${registryLimits.accounts} accounts`);
  };
  const setRole = (role: FleetRole) => {
    const unknown = role.accounts.filter(name => !next.accounts.some(account => account.name === name));
    demandRegistry(!unknown.length, `Unknown account${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}; add an account before the role that names it`);
    upsert(next.roles, role);
  };
  let reasonText: string;
  if (kind === 'runtime.set') { const data = registryMutationSchemas[kind].parse(input); reasonText = data.reason; setRuntime(data.runtime); }
  else if (kind === 'runtime.remove') {
    const data = registryMutationSchemas[kind].parse(input); reasonText = data.reason;
    demandRegistry(next.runtimes.some(runtime => runtime.name === data.name), `Unknown runtime ${data.name}`);
    next.runtimes = next.runtimes.filter(runtime => runtime.name !== data.name);
    dropAccounts(next.accounts.filter(account => account.runtime === data.name).map(account => account.name));
  }
  else if (kind === 'model.set') { const data = registryMutationSchemas[kind].parse(input); reasonText = data.reason; setModel(data.model); }
  else if (kind === 'model.remove') {
    const data = registryMutationSchemas[kind].parse(input); reasonText = data.reason;
    demandRegistry(next.models.some(model => model.name === data.name), `Unknown model ${data.name}`);
    const users = next.accounts.filter(account => account.model === data.name).map(account => account.name);
    demandRegistry(!users.length, `Model ${data.name} is what ${users.join(', ')} run${users.length === 1 ? 's' : ''}; point ${users.length === 1 ? 'that account' : 'those accounts'} at another model first`);
    next.models = next.models.filter(model => model.name !== data.name);
  }
  else if (kind === 'account.set') { const data = registryMutationSchemas[kind].parse(input); reasonText = data.reason; setAccount(data.account); }
  else if (kind === 'account.remove') {
    const data = registryMutationSchemas[kind].parse(input); reasonText = data.reason;
    demandRegistry(next.accounts.some(account => account.name === data.name), `Unknown account ${data.name}`);
    dropAccounts([data.name]);
  }
  else if (kind === 'account.quota') {
    const data = registryMutationSchemas[kind].parse(input); reasonText = data.reason;
    const account = next.accounts.find(entry => entry.name === data.name);
    demandRegistry(account, `Unknown account ${data.name}`);
    account.quota = { ...data.quota, reason: data.quota.reason ?? data.reason.slice(0, 500), observedAt: context.at, observedBy: context.actor, source: 'operator' };
  }
  else if (kind === 'role.set') { const data = registryMutationSchemas[kind].parse(input); reasonText = data.reason; setRole(data.role); }
  else if (kind === 'role.remove') {
    const data = registryMutationSchemas[kind].parse(input); reasonText = data.reason;
    demandRegistry(next.roles.some(role => role.name === data.name), `Role ${data.name} is not configured`);
    next.roles = next.roles.filter(role => role.name !== data.name);
  }
  else {
    const data = registryMutationSchemas.apply.parse(input); reasonText = data.reason;
    demandRegistry(data.runtimes.length + data.models.length + data.accounts.length + data.roles.length > 0, 'The proposal is empty; nothing to apply');
    data.runtimes.forEach(setRuntime); data.models.forEach(setModel); data.accounts.forEach(setAccount); data.roles.forEach(setRole);
  }
  next.revision = current.revision + 1; next.updatedAt = context.at;
  next.lastMutation = { kind, actor: context.actor, at: context.at, reason: reasonText };
  return { registry: next, removed };
}

/**
 * Fold an executor's probe into what the registry knows. An operator's exhausted mark stands until
 * its reset passes or an operator clears it, whatever a probe reads meanwhile: the mark exists for
 * what a probe cannot see — a plan the provider cut off, a runtime whose quota Graphyard cannot
 * read — so only the login state is taken from the probe while it holds. Returns whether anything
 * an eligibility decision reads has changed, so a steady state appends nothing to the ledger.
 */
export function foldObservation(account: FleetAccount, observed: QuotaObservation, context: { actor: string; at: string }) {
  const held = account.quota, now = Date.parse(context.at);
  const operatorHold = held.source === 'operator' && held.state === 'exhausted' && (!held.resetsAt || Date.parse(held.resetsAt) > now);
  if (operatorHold) {
    if (observed.loggedIn === null || observed.loggedIn === held.loggedIn) return false;
    account.quota = { ...held, loggedIn: observed.loggedIn }; return true;
  }
  // A provider restates the same reset to the millisecond or not at all; only a reset that really moved is a change.
  const moved = (held.resetsAt === null) !== (observed.resetsAt === null) || !!held.resetsAt && !!observed.resetsAt && Math.abs(Date.parse(held.resetsAt) - Date.parse(observed.resetsAt)) > 60_000;
  const changed = held.loggedIn !== observed.loggedIn || held.state !== observed.state || moved || held.source !== 'probe';
  account.quota = { ...observed, observedAt: context.at, observedBy: context.actor, source: 'probe' };
  return changed;
}

export const launchGraceMs = 5 * 60_000, reviewSessionMs = 2 * 3_600_000, producerSessionMs = 24 * 3_600_000, decisionSessionMs = 30 * 60_000, sessionCapMs = 48 * 3_600_000;
type SessionWork = Pick<Work, 'key' | 'lease' | 'autoDispatch' | 'stage'>;
/**
 * Whether a recorded session still occupies its account, and why not when it does not. Nothing
 * reports a session's end: the control plane already knows what each one was launched for, so a
 * worker session lives as long as its item's lease, a reviewer or producer session as long as the
 * request it answers stands, and a decision session for a bounded time. Every session is live
 * through a launch grace, because the claim or the request follows the choice.
 */
export function sessionEnded(session: FleetSession, work: SessionWork | undefined, now: number): string | null {
  if (session.endedAt) return session.endReason ?? 'ended';
  const age = now - Date.parse(session.selectedAt);
  if (age < launchGraceMs) return null;
  if (age > sessionCapMs) return 'older than any session runs';
  if (session.role === 'approver' || session.role === 'escalation-handler') return age > decisionSessionMs ? 'the decision window passed' : null;
  if (!work) return session.work ? `${session.work} is no longer an open work item` : 'the launch grace passed and the session names no work item';
  if (session.role === 'worker') {
    const lease = work.lease;
    if (!lease || Date.parse(lease.expiresAt) <= now) return `${work.key} holds no live lease`;
    return session.principal && lease.owner !== session.principal ? `${work.key} is leased to ${lease.owner}` : null;
  }
  if (session.role === 'reviewer') return work.autoDispatch?.review?.state === 'requested' && age <= reviewSessionMs ? null : `${work.key} has no standing review request`;
  return (work.autoDispatch?.producers ?? []).some(request => request.state === 'requested') && age <= producerSessionMs ? null : `${work.key} has no standing producer request`;
}

/** Close every session whose reason to exist has gone; returns the ones it closed. */
export function settleSessions(registry: AgentRegistry, work: readonly SessionWork[], at: string) {
  const now = Date.parse(at), byKey = new Map(work.map(item => [item.key, item])), closed: FleetSession[] = [];
  // A relaunch for the same work supersedes the session it replaces: a reviewer request is answered
  // by one session, a worker lease held by one, and a producer request group by one each.
  const open = registry.sessions.filter(session => !session.endedAt);
  for (const session of open) {
    let ended = sessionEnded(session, session.work ? byKey.get(session.work) : undefined, now);
    if (!ended && session.work && session.role !== 'producer') {
      const newer = open.find(other => other !== session && other.role === session.role && other.work === session.work && Date.parse(other.selectedAt) > Date.parse(session.selectedAt));
      if (newer) ended = `superseded by the ${newer.account} session launched for ${session.work}`;
    }
    if (!ended && session.work && session.role === 'producer') {
      const standing = (byKey.get(session.work)?.autoDispatch?.producers ?? []).filter(request => request.state === 'requested').length;
      const newer = open.filter(other => other.role === 'producer' && other.work === session.work && Date.parse(other.selectedAt) > Date.parse(session.selectedAt)).length;
      if (standing > 0 && newer >= standing) ended = `superseded by newer producer sessions for ${session.work}`;
    }
    if (ended) { session.endedAt = at; session.endReason = ended; closed.push(session); }
  }
  const live = registry.sessions.filter(session => !session.endedAt), ended = registry.sessions.filter(session => session.endedAt);
  registry.sessions = [...ended.slice(-Math.max(0, sessionHistoryLimit - live.length)), ...live].sort((a, b) => Date.parse(a.selectedAt) - Date.parse(b.selectedAt));
  return closed;
}
export const liveSessions = (registry: Pick<AgentRegistry, 'sessions'>) => registry.sessions.filter(session => !session.endedAt);

const until = (iso: string | null) => iso ? ` until ${iso}` : '';
/**
 * Why an account cannot take a session right now, whatever role asks — null when it can. `host`
 * is the executor asking: an account is placed where its login lives, so every other host is
 * refused it. Without a host the placement is not judged (a report has no single asking host).
 */
export function accountIneligibility(registry: AgentRegistry, account: FleetAccount, now: number, host?: string | null): string | null {
  if (!account.enabled) return `${account.name} is disabled`;
  if (!registry.runtimes.some(runtime => runtime.name === account.runtime)) return `${account.name} runs ${account.runtime}, which is not a registered runtime`;
  if (!registry.models.some(model => model.name === account.model)) return `${account.name} runs ${account.model}, which is not a registered model`;
  if (host && account.credential.host !== host) return `${account.name} is placed on ${account.credential.host}; this executor is ${host}`;
  if (account.quota.loggedIn === false) return `${account.name} is not logged in`;
  if (account.quota.state === 'exhausted' && (!account.quota.resetsAt || Date.parse(account.quota.resetsAt) > now)) return `${account.name} quota is exhausted${until(account.quota.resetsAt)}${account.quota.reason ? ` (${account.quota.reason})` : ''}`;
  const running = liveSessions(registry).filter(session => session.account === account.name).length;
  if (account.maxSessions !== null && running >= account.maxSessions) return `${account.name} is at its session limit (${running} of ${account.maxSessions} live)`;
  return null;
}

export interface SessionChoice { account: FleetAccount; runtime: FleetRuntime; model: FleetModel; reason: string; skipped: SessionSkip[] }
export interface SessionRefusal { account: null; reason: string; skipped: SessionSkip[] }
/**
 * The session an action runs on: the first account of the role, in the role's own order, that is
 * placed on the asking host, logged in, within quota and under its session limit, provided the
 * role itself is under its concurrency limit. Pure: the registry passed in already carries the
 * executor's fresh observations and only sessions that are still live.
 */
export function chooseSession(registry: AgentRegistry, request: Pick<SelectionRequest, 'role' | 'host'>, now: number): SessionChoice | SessionRefusal {
  const role = registry.roles.find(entry => entry.name === request.role);
  if (!role) return { account: null, reason: `role ${request.role} is not configured in the agent registry`, skipped: [] };
  if (!role.accounts.length) return { account: null, reason: `role ${request.role} names no account`, skipped: [] };
  const running = liveSessions(registry).filter(session => session.role === role.name);
  if (running.length >= role.concurrency) return { account: null, skipped: [],
    reason: role.concurrency === 0 ? `role ${role.name} is paused (concurrency 0)` : `role ${role.name} is at its concurrency limit (${running.length} of ${role.concurrency} live: ${running.map(session => `${session.account}${session.work ? ` on ${session.work}` : ''}`).join(', ')})` };
  const skipped: SessionSkip[] = [];
  for (const [index, name] of role.accounts.entries()) {
    const account = registry.accounts.find(entry => entry.name === name);
    const refusal = account ? accountIneligibility(registry, account, now, request.host) : `${name} is not a registered account`;
    if (refusal) { skipped.push({ account: name, reason: refusal }); continue; }
    const runtime = registry.runtimes.find(entry => entry.name === account!.runtime)!, model = registry.models.find(entry => entry.name === account!.model)!;
    return { account: account!, runtime, model, skipped,
      reason: `${name} is the first eligible account for ${role.name} (preference ${index + 1} of ${role.accounts.length}; ${running.length + 1} of ${role.concurrency} concurrent)${skipped.length ? ` — passed over ${skipped.map(entry => entry.reason).join('; ')}` : ''}` };
  }
  return { account: null, skipped, reason: `no eligible account for ${role.name}: ${skipped.map(entry => entry.reason).join('; ')}` };
}

export interface FleetAccountView {
  name: string; runtime: string; model: string; modelId: string | null; cost: FleetModel['cost'] | null; capability: FleetModel['capability'] | null;
  host: string; home: string | null; enabled: boolean; maxSessions: number | null; note: string | null;
  /** Every role that names the account, with its place in that role's order. */
  roles: { role: FleetRoleName; preference: number; of: number }[];
  liveSessions: { id: string; role: FleetRoleName; work: string | null; host: string; since: string }[];
  quota: ObservedQuota['state']; loggedIn: boolean | null; usage: ObservedQuota['usage']; resetsAt: string | null; observedAt: string | null; quotaSource: ObservedQuota['source'];
  eligible: boolean;
  /** Why the account cannot take a session now; null when it can. */
  ineligible: string | null;
}
export interface FleetRoleView { role: FleetRoleName; accounts: string[]; concurrency: number; live: number; next: string | null; blocked: string | null }
export interface FleetView {
  revision: number; updatedAt: string | null; configured: boolean; host: string | null;
  runtimes: FleetRuntime[]; models: FleetModel[]; accounts: FleetAccountView[]; roles: FleetRoleView[];
  sessions: FleetSession[]; refusals: FleetRefusal[]; lastMutation: AgentRegistry['lastMutation'];
  attention: string[];
}

/**
 * The registry as status and the dashboard show it: each account with its runtime, model, role
 * eligibility, live sessions, quota and reset time, and the reason it is ineligible when it is;
 * each role with the account its next action would run on, or what stops it.
 */
export function fleetView(registry: AgentRegistry, now: number, host: string | null = null): FleetView {
  const live = liveSessions(registry);
  const accounts: FleetAccountView[] = registry.accounts.map(account => {
    const model = registry.models.find(entry => entry.name === account.model);
    const ineligible = accountIneligibility(registry, account, now, host);
    return { name: account.name, runtime: account.runtime, model: account.model, modelId: model?.id ?? null, cost: model?.cost ?? null, capability: model?.capability ?? null,
      host: account.credential.host, home: account.credential.home, enabled: account.enabled, maxSessions: account.maxSessions, note: account.note ?? null,
      roles: registry.roles.filter(role => role.accounts.includes(account.name)).map(role => ({ role: role.name, preference: role.accounts.indexOf(account.name) + 1, of: role.accounts.length })),
      liveSessions: live.filter(session => session.account === account.name).map(session => ({ id: session.id, role: session.role, work: session.work, host: session.host, since: session.selectedAt })),
      quota: account.quota.state, loggedIn: account.quota.loggedIn, usage: account.quota.usage, resetsAt: account.quota.resetsAt, observedAt: account.quota.observedAt, quotaSource: account.quota.source,
      eligible: !ineligible, ineligible };
  });
  const roles: FleetRoleView[] = registry.roles.map(role => {
    const choice = host ? chooseSession(registry, { role: role.name, host }, now) : null;
    const first = host ? choice?.account?.name ?? null : role.accounts.find(name => accounts.find(account => account.name === name)?.eligible) ?? null;
    const running = live.filter(session => session.role === role.name).length;
    const blocked = host ? (choice!.account ? null : choice!.reason) : running >= role.concurrency ? `role ${role.name} is at its concurrency limit (${running} of ${role.concurrency} live)` : first ? null : `no eligible account for ${role.name}`;
    return { role: role.name, accounts: role.accounts, concurrency: role.concurrency, live: running, next: blocked ? null : first, blocked };
  });
  const unassigned = accounts.filter(account => !account.roles.length).map(account => `${account.name} serves no role; name it in a role or remove it`);
  const missing = registry.accounts.length ? fleetRoles.filter(name => !registry.roles.some(role => role.name === name)).map(name => `role ${name} is not configured; its sessions launch from local profiles until it is`) : [];
  return { revision: registry.revision, updatedAt: registry.updatedAt, configured: registry.roles.length > 0, host, runtimes: registry.runtimes, models: registry.models, accounts, roles,
    sessions: registry.sessions.slice(-30), refusals: registry.refusals, lastMutation: registry.lastMutation,
    attention: [...roles.filter(role => role.blocked).map(role => role.blocked!), ...unassigned, ...missing] };
}

/**
 * The launch contracts setup proposes for the agent CLIs Graphyard knows how to start unattended.
 * They are proposals only: a registry stores its own copy, an operator edits it there, and a
 * runtime added later needs no entry here. Approval flags themselves stay with the harness
 * (src/harness.ts); `args` holds what a runtime needs beyond them.
 */
export const proposedRuntimes: readonly FleetRuntime[] = [
  { name: 'claude', description: 'Claude Code', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: '--model', login: 'CLAUDE_CONFIG_DIR={home} claude, then /login', loginFile: '.credentials.json' } },
  { name: 'codex', description: 'OpenAI Codex CLI', launch: { kind: 'codex', args: [], environment: {}, homeVariable: 'CODEX_HOME', modelFlag: '--model', login: 'CODEX_HOME={home} codex login', loginFile: 'auth.json' } },
  { name: 'cursor', description: 'Cursor agent CLI', launch: { kind: 'cursor', args: [], environment: {}, homeVariable: 'CURSOR_CONFIG_DIR', modelFlag: '--model', login: 'CURSOR_CONFIG_DIR={home} cursor-agent login', loginFile: 'cli-config.json' } },
  { name: 'opencode', description: 'OpenCode', launch: { kind: 'opencode', args: [], environment: {}, homeVariable: 'XDG_DATA_HOME', modelFlag: '--model', login: 'XDG_DATA_HOME={home} opencode auth login', loginFile: 'opencode/auth.json' } },
  { name: 'muse', description: 'Muse', launch: { kind: 'muse', args: ['--approval-mode', 'never', '--trust-workspace'], environment: {}, homeVariable: null, modelFlag: null, login: 'muse login', loginFile: null } },
];

/** Default concurrency a proposal gives each role; an operator changes it in the registry. */
export const proposedConcurrency: Record<FleetRoleName, number> = { worker: 4, reviewer: 2, producer: 3, approver: 1, 'escalation-handler': 1 };
