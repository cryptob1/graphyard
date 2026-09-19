import { delegationLimitDrift, delegationLimitVariables, delegationLimits, validateDelegationPrincipals, type DelegationLimitDrift, type DelegationLimits } from '../delegation.js';
import type { Principal } from '../model.js';

/** The limits in force, the deployed variables, and every way they fail to cover the roster. */
export interface DelegationLimitReport { limits: DelegationLimits; deployed: Record<string, string | null>; drift: DelegationLimitDrift[]; attention: string[] }

/**
 * Start-up capacity assembly. The limits derive from the configured roster, so an
 * installation never refuses to start over a default it was already exceeding; the roster
 * check refuses only a principal added beyond an explicit limit, and the drift report says
 * exactly what to set. `known` is the roster this installation already ran with.
 */
export function assembleDelegationLimits(credentials: (Principal & { token?: string })[], env: NodeJS.ProcessEnv, known?: readonly string[]): DelegationLimitReport {
  const limits = delegationLimits(env, credentials);
  const roster = validateDelegationPrincipals(credentials, limits, known);
  const drift = delegationLimitDrift(credentials, env);
  return { limits, deployed: Object.fromEntries(delegationLimitVariables.map(name => [name, env[name] ?? null])), drift, attention: [...roster.attention, ...drift.map(entry => entry.reason)] };
}
