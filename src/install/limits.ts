import { delegationLimitDrift, delegationLimitVariables, requiredDelegationLimits, type DelegationLimitDrift, type DelegationLimitVariable } from '../delegation.js';

export { delegationLimitDrift, delegationLimitVariables, requiredDelegationLimits, type DelegationLimitDrift, type DelegationLimitVariable };

/**
 * What every installer and provider adapter writes beside GRAPHYARD_PRINCIPALS: the
 * GRAPHYARD_MAX_ and GRAPHYARD_MIN_ variables derived from the principal set it generates. The server
 * derives the same limits when a variable is unset, but an explicit value is what keeps an
 * install predictable across upgrades that change a default. `deployed` is the deployment's
 * current variables when the adapter can read them; a re-run then reports drift — a deployed
 * value that no longer covers the principals — before it sets the corrected values.
 */
export interface DelegationLimitAssignment { variables: Record<DelegationLimitVariable, string>; lines: string[]; drift: DelegationLimitDrift[] }
/** `deployed` null means the adapter could not read the deployment: nothing to report drift against. A known-unset variable is `null` inside the record. */
export function delegationLimitAssignments(principals: readonly { id: string; role: string }[], deployed: Record<string, string | null | undefined> | null = null): DelegationLimitAssignment {
  const known = Object.fromEntries(Object.entries(deployed ?? {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
  const variables = requiredDelegationLimits(principals as any, known);
  return { variables, lines: delegationLimitVariables.map(name => `${name}=${variables[name]}`), drift: deployed ? delegationLimitDrift(principals as any, known) : [] };
}
