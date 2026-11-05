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
export interface FleetAccount extends FleetAccountInput { quota: ObservedQuota; smoke?: AccountSmoke | null; unjudged?: Partial<Record<FleetRoleName, UnjudgedRuns>> }

/** The roles a configured registry is expected to name. Setup proposes every one of them, master included (GY-2939); an operator re-names any role's accounts. */
export const fleetRoles = ['worker', 'reviewer', 'producer', 'master'] as const;
/**
 * Every role the registry may define: the proposed ones, and the retired diagnostician (GY-439),
 * doctor (GY-711), escalation handler and approver (GY-2874), acceptance role and planner (GY-2875),
 * which a registry still naming them keeps parsing.
 */
export const registryRoles = [...fleetRoles, 'approver', 'escalation-handler', 'diagnostician', 'doctor', 'acceptance', 'planner'] as const;
export type FleetRoleName = typeof registryRoles[number];
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
