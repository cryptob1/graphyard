import type { z } from 'zod';
import type { launchContractSchema, runtimeSchema, modelSchema, quotaObservationSchema, accountSchema, rolePolicySchema, roleSchema, registryMutationSchemas, selectionRequestSchema } from '../model-boundary/registry.js';
import type { AccountSmoke, UnjudgedRuns, RunOutcome } from './registry-keys.js';
// Pure string check, so the dashboard can share this module without a Node import.
export const isAbsolute = (value: string) => /^(\/|[A-Za-z]:[\\/])/.test(value);
export const secretName = /(TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY|CREDENTIAL)/;
export type LaunchContract = z.infer<typeof launchContractSchema>;
export type FleetRuntime = z.infer<typeof runtimeSchema>;

export const capabilityTiers = ['frontier', 'strong', 'fast'] as const;
export type FleetModel = z.infer<typeof modelSchema>;

export const quotaStates = ['available', 'exhausted', 'unknown'] as const;
export type QuotaObservation = z.infer<typeof quotaObservationSchema>;
export interface ObservedQuota extends QuotaObservation { observedAt: string | null; observedBy: string | null; source: 'probe' | 'operator' | null }
export const unobservedQuota: ObservedQuota = { loggedIn: null, state: 'unknown', usage: [], resetsAt: null, reason: null, identity: null, observedAt: null, observedBy: null, source: null };
export type FleetAccountInput = z.infer<typeof accountSchema>;
/** An operator's latest quota decision on an account (GY-3117): kept through probes and account changes, so no exhaustion observed before it is applied again. */
export interface QuotaDecision { state: QuotaObservation['state']; at: string }
export interface FleetAccount extends FleetAccountInput { quota: ObservedQuota; quotaDecision?: QuotaDecision; smoke?: AccountSmoke | null; unjudged?: Partial<Record<FleetRoleName, UnjudgedRuns>> }

/** The roles a configured registry is expected to name. Setup proposes every one of them, master included (GY-2939); an operator re-names any role's accounts. */
export const fleetRoles = ['worker', 'reviewer', 'producer', 'master'] as const;
/**
 * Every role the registry may define: the proposed ones, and the retired diagnostician (GY-439),
 * doctor (GY-711), escalation handler and approver (GY-2874), acceptance role and planner (GY-2875),
 * which a registry still naming them keeps parsing.
 */
export const registryRoles = [...fleetRoles, 'approver', 'escalation-handler', 'diagnostician', 'doctor', 'acceptance', 'planner'] as const;
export type FleetRoleName = typeof registryRoles[number];
/**
 * Which launch kinds each role can run — the role's declared runtime capability. A role not
 * declared here runs any registered runtime. The master resumes a durable native conversation
 * with full read-only retention, which only Claude and Codex record (src/master/conversation.ts);
 * every other role imposes no runtime constraint. The registry's role mutation refuses an account
 * outside this list and selection passes it over, so a role never depends on a failed launch to
 * learn what it can run.
 */
export const roleRuntimeKinds: Partial<Record<FleetRoleName, readonly string[]>> = { master: ['claude', 'codex'] };
const runtimeList = (list: readonly string[]) => list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
/**
 * Why `account`'s runtime cannot serve `role`, or null when it can: names the account's runtime
 * and the ones the role supports, so the refusal says exactly what to change. An account naming
 * an unregistered runtime is refused by the registry's own reference checks, not here.
 */
export function roleRuntimeRefusal(registry: Pick<AgentRegistry, 'runtimes'>, account: FleetAccount, role: FleetRoleName): string | null {
  const supported = roleRuntimeKinds[role];
  if (!supported) return null;
  const runtime = registry.runtimes.find(entry => entry.name === account.runtime);
  if (!runtime) return null;
  if (supported.includes(runtime.launch.kind)) return null;
  const named = runtime.name === runtime.launch.kind ? `runtime ${runtime.name}` : `runtime ${runtime.name} (kind ${runtime.launch.kind})`;
  return `${account.name} runs ${named}, which the ${role} role cannot run; the ${role} role supports ${runtimeList(supported)}`;
}
export type RolePolicy = z.infer<typeof rolePolicySchema>;
export const emptyRolePolicy = (): RolePolicy => ({ args: [], tools: [], model: null });
export type FleetRole = z.infer<typeof roleSchema>;
/** A role's launch policy, the empty one when it records none. */
export const rolePolicy = (role: Pick<FleetRole, 'policy'> | undefined): RolePolicy => ({ ...emptyRolePolicy(), ...role?.policy });

export interface SessionSkip { account: string; reason: string }
/** One recorded choice: who asked, what was chosen, why, and everything passed over on the way. */
export interface FleetSession {
  id: string; role: FleetRoleName; account: string; runtime: string; model: string;
  host: string; work: string | null; principal: string | null;
  /** A producer's proof group or a personal master's human owner. */
  group?: string | null;
  selectedAt: string; selectedBy: string; reason: string; skipped: SessionSkip[];
  endedAt: string | null; endReason: string | null;
  /** For a headless run, whether it ended with a result (GY-446); recorded once. */
  outcome?: RunOutcome;
}
/** One refusal of a request; identical refusals of it after this one are counted in registry_refusal_repeats (GY-3095). */
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
export type RegistryMutation = keyof typeof registryMutationSchemas;
export const registryLimits = { runtimes: 50, models: 100, accounts: 200 } as const;
export type SelectionRequest = z.infer<typeof selectionRequestSchema>;

/** How an executor names itself on a read, so placement is judged for it (by header, so an older server ignores it). */
export const executorHostHeader = 'X-Graphyard-Host';
export class RegistryError extends Error {}
export const demandRegistry: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new RegistryError(message); };
export const upsert = <T extends { name: string }>(list: T[], entry: T) => { const at = list.findIndex(item => item.name === entry.name); if (at < 0) list.push(entry); else list[at] = entry; };

// Session liveness, eligibility, selection and the status view; and what setup proposes.
export * from './registry-keys.js';
export * from './registry-sessions.js';
export * from './account-quota.js';
export * from './registry-proposal.js';
export * from './provider-usage.js';

/** GY-3103: a version directory's name, as mise and similar installers write it: 2.2.5, v1.10.0, 1.0.0-beta.1. */
export const versionName = /^v?\d+(?:\.\d+)*(?:[-+][\w.]+)?$/;
const versionParts = (name: string) => { const [core, pre] = name.replace(/^v/, '').split(/[-+](.*)/s); return { core: core.split('.').map(Number), pre: pre ?? null }; };
/** Orders version names: by their numeric parts, then a release above its prereleases. */
export function compareVersions(a: string, b: string) {
  const x = versionParts(a), y = versionParts(b);
  for (let at = 0; at < Math.max(x.core.length, y.core.length); at++) { const delta = (x.core[at] ?? 0) - (y.core[at] ?? 0); if (delta) return delta; }
  return x.pre === y.pre ? 0 : x.pre === null ? 1 : y.pre === null ? -1 : x.pre.localeCompare(y.pre);
}
export const newestVersion = (names: readonly string[]) => names.filter(name => versionName.test(name)).sort(compareVersions).at(-1) ?? null;

/**
 * Where a runtime's pinned install sits (GY-3103): the first entry of its launch PATH split at the
 * first path segment naming a version — `root` holds every installed version, `rest` is the part
 * below the version (e.g. `bin`). Null for a runtime whose PATH is not led by a versioned install.
 */
export function pinnedInstall(runtime: Pick<FleetRuntime, 'launch'>): { entry: string; root: string; version: string; rest: string } | null {
  const entry = runtime.launch.environment?.PATH?.split(':')[0];
  if (!entry || !isAbsolute(entry)) return null;
  const parts = entry.split('/'), at = parts.findIndex(part => versionName.test(part));
  if (at < 2) return null;
  return { entry, root: parts.slice(0, at).join('/'), version: parts[at], rest: parts.slice(at + 1).join('/') };
}
/** A newer installed version of a registry runtime, offered to one launch as its canary: `entry` leads that launch's PATH. */
export interface CanaryOffer { runtime: string; entry: string; version: string }
/** The PATH entry `version` of a pinned install would lead with. */
export const versionEntry = (pin: { root: string; rest: string }, version: string) => [pin.root, version, pin.rest].filter(Boolean).join('/');
/** A PATH whose first entry is `entry`, the rest kept. */
export const repinPath = (path: string, entry: string) => [entry, ...path.split(':').slice(1)].join(':');
/** The runtime launched from `entry`: its PATH led by it, every other part of its launch kept. */
export const repinRuntime = (runtime: FleetRuntime, entry: string): FleetRuntime =>
  ({ ...runtime, launch: { ...runtime.launch, environment: { ...runtime.launch.environment, PATH: repinPath(runtime.launch.environment?.PATH ?? '', entry) } } });
