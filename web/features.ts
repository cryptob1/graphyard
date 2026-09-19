import { useEffect, useState } from 'react';

/**
 * Whether each optional feature has anything configured: `true` or `false` once a read has
 * answered, `null` while unknown or when the read failed. Navigation hides a page only on a
 * confirmed `false`, so a feature nobody uses is not an empty explainer and an outage never
 * hides a page that has data.
 */
export interface Features { validation: boolean | null; releases: boolean | null; automation: boolean | null }
export const unknownFeatures: Features = { validation: null, releases: null, automation: null };

type Read = (path: string) => Promise<any>;
/**
 * `operatorAgentsError` carries the failure of the operator-automation read, because an empty
 * list and an unavailable read mean opposite things to a reader: one is the safe bootstrap
 * default, the other is an outage. The page says which it is.
 */
export interface Probe { features: Features; operatorAgents: any[]; operatorAgentsError: string | null }
export async function probeFeatures(read: Read, admin: boolean, hasScenarios: boolean): Promise<Probe> {
  const settle = async <T,>(path: string, decide: (value: any) => T) => { try { return decide(await read(path)); } catch { return null; } };
  const attempt = async (path: string) => { try { return { value: await read(path), error: null }; } catch (e) { return { value: null, error: (e as Error).message || 'The read failed.' }; } };
  const [releases, validation, automation] = await Promise.all([
    settle('delivery', value => (value?.environments?.length ?? 0) + (value?.releases?.length ?? 0) > 0),
    settle('validation', value => hasScenarios || (value?.requests?.length ?? 0) > 0),
    admin ? attempt('operator-agents') : Promise.resolve({ value: [], error: null }),
  ]);
  const agents = Array.isArray(automation.value) ? automation.value : null;
  return {
    features: { releases, validation, automation: admin ? agents === null ? null : agents.length > 0 : false },
    operatorAgents: agents ?? [], operatorAgentsError: admin ? automation.error ?? (agents === null ? 'The control plane answered with something other than a list of identities.' : null) : null,
  };
}

/** Probes once per sign-in and then every minute; a newer probe never loses to an older one. */
export function useFeatures(token: string, ready: boolean, read: Read, admin: boolean, hasScenarios: boolean) {
  const [state, setState] = useState<Probe>({ features: unknownFeatures, operatorAgents: [], operatorAgentsError: null });
  useEffect(() => {
    setState({ features: unknownFeatures, operatorAgents: [], operatorAgentsError: null });
    if (!token || !ready) return;
    let active = true;
    const load = () => void probeFeatures(read, admin, hasScenarios).then(next => { if (active) setState(next); });
    load(); const timer = setInterval(load, 60000);
    return () => { active = false; clearInterval(timer); };
  }, [token, ready, admin, hasScenarios]);
  return state;
}
