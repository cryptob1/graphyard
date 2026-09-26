import { z } from 'zod';

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
/** Whether a value looks like a pasted credential: the dashboard refuses to send one, and the registry to store one. */
export const looksLikeSecret = (value: string) => secretValue.test(value.trim());

const launchEnvironment = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/)
    .refine(name => !name.startsWith('GRAPHYARD_'), 'GRAPHYARD_ variables are owned by the launcher')
    .refine(name => !secretName.test(name), 'A launch contract never carries a secret; the credential lives in the runtime login the account references'),
  z.string().min(1).max(1000).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Environment values cannot contain control characters').refine(notSecret, 'That value looks like a credential; the registry stores references, never secrets'),
).default({});

/**
 * How a session of a runtime is started. `kind` is what the session host launches (the agent
 * kind it knows the executable by). `args` are the runtime's own non-interactive startup arguments,
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
  /** The argument that limits a session to a tool allowlist (a role's `policy.tools`, joined by commas); null when the runtime has none. */
  toolsFlag: z.string().regex(/^--?[a-zA-Z][a-zA-Z0-9-]*$/).nullable().optional(),
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

/** The roles setup proposes and a configured registry is expected to name. */
export const fleetRoles = ['worker', 'reviewer', 'producer', 'approver', 'escalation-handler'] as const;
/**
 * Every role the registry may define: the proposed ones, and the doctor (GY-711), which finds stuck
 * and overdue work every ten minutes and fixes it through its sanctioned commands. The doctor runs
 * headless on Pi from `run.doctor` until an operator names accounts for it here, so it is never
 * proposed and never reported missing.
 */
export const registryRoles = [...fleetRoles, 'doctor'] as const;
export type FleetRoleName = typeof registryRoles[number];
/**
 * How every session of a role is launched, whichever account serves it (GY-170): the runtime
 * flags it starts with beyond its runtime's contract — a permission mode, an auto-approve flag —
 * the tools it may use, and the model it runs in place of each account's own. The launcher still
 * refuses flags that would let a session stop to ask (src/harness.ts), so a policy narrows what a
 * session may do and never brings a prompt back. Like everything else here it holds no secret.
 */
export const rolePolicySchema = z.object({
  args: z.array(z.string().min(1).max(1000).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed').refine(notSecret, 'That argument looks like a credential; the registry stores references, never secrets')).max(30).default([]),
  /** The tools a session may use, passed on the runtime's `toolsFlag`; empty leaves the runtime's own set. */
  tools: z.array(z.string().trim().min(1).max(200).refine(value => !value.includes(','), 'One tool per entry').refine(notSecret, 'A tool is a name, never a credential')).max(100).default([]),
  /** A registered model this role runs instead of each account's own; null keeps the account's. */
  model: entryName.nullable().default(null),
}).strict();
export type RolePolicy = z.infer<typeof rolePolicySchema>;
export const emptyRolePolicy = (): RolePolicy => ({ args: [], tools: [], model: null });
export const roleSchema = z.object({
  name: z.enum(registryRoles),
  /** Eligible accounts, most preferred first. */
  accounts: z.array(entryName).max(50).refine(list => new Set(list).size === list.length, 'A role lists each account once'),
  /** How many sessions of this role may run at once; 0 pauses the role. */
  concurrency: z.number().int().min(0).max(100),
  /** The role's launch policy; a role stored before GY-170 has none, which is the empty policy. */
  policy: rolePolicySchema.optional(),
}).strict();
export type FleetRole = z.infer<typeof roleSchema>;
/** A role's launch policy, the empty one when it records none. */
export const rolePolicy = (role: Pick<FleetRole, 'policy'> | undefined): RolePolicy => ({ ...emptyRolePolicy(), ...role?.policy });

export interface SessionSkip { account: string; reason: string }
/** One recorded choice: who asked, what was chosen, why, and everything passed over on the way. */
export interface FleetSession {
  id: string; role: FleetRoleName; account: string; runtime: string; model: string;
  host: string; work: string | null; principal: string | null;
  /** For a producer, the proof group its session answers: one live session per group, not per item. */
  group?: string | null;
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
  'role.remove': z.object({ name: z.enum(registryRoles), reason }).strict(),
  /** A whole proposal at once, in dependency order: what setup discovers and an operator accepts. */
  apply: z.object({ runtimes: z.array(runtimeSchema).max(50).default([]), models: z.array(modelSchema).max(100).default([]), accounts: z.array(accountSchema).max(200).default([]), roles: z.array(roleSchema).max(registryRoles.length).default([]), reason }).strict(),
} as const;
export type RegistryMutation = keyof typeof registryMutationSchemas;
export const registryLimits = { runtimes: 50, models: 100, accounts: 200 } as const;

export const selectionRequestSchema = z.object({
  role: z.enum(registryRoles),
  host: hostName,
  work: z.string().trim().min(1).max(40).nullable().default(null),
  principal: z.string().trim().min(1).max(200).nullable().default(null),
  /** The proof group a producer request answers; every other role names none. */
  group: z.string().trim().min(1).max(40).nullable().default(null),
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
    const model = role.policy?.model;
    demandRegistry(!model || next.models.some(entry => entry.name === model), `Unknown model ${model}; add the model before the role policy that runs it`);
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
    const roles = next.roles.filter(role => role.policy?.model === data.name).map(role => role.name);
    demandRegistry(!roles.length, `Model ${data.name} is what the ${roles.join(', ')} role policy runs; change that policy first`);
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

// Session liveness, eligibility, selection and the status view; and what setup proposes.
export * from './registry-sessions.js';
export * from './registry-proposal.js';
