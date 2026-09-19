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

/**
 * The capacity variables a running deployment reports under `delegationLimits.deployed` in
 * `GET /api/status`, read with an operator credential. Every adapter that re-runs against a
 * live server reads them this way so its drift report compares the principal set it is about
 * to deploy with what the deployment runs with now. `deployed` is null when the server cannot
 * be read; `error` says why, so the adapter prints that no drift can be reported instead of
 * reporting none.
 */
export async function readDeployedDelegationLimits(url: string, token: string, fetchImpl: typeof fetch = fetch): Promise<{ deployed: Record<string, string | null> | null; error: string | null }> {
  const base = url.replace(/\/$/, '');
  try {
    const response = await fetchImpl(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const status: any = await response.json().catch(() => null);
    if (response.ok && status?.delegationLimits?.deployed && typeof status.delegationLimits.deployed === 'object') return { deployed: status.delegationLimits.deployed, error: null };
    return { deployed: null, error: `Deployed limits could not be read from ${base} (${response.ok ? 'the server reports no delegationLimits; deploy main first' : `HTTP ${response.status}`}); no drift can be reported` };
  } catch (error: any) {
    return { deployed: null, error: `Deployed limits could not be read from ${base}: ${error.message}; no drift can be reported` };
  }
}
