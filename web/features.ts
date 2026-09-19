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
export async function probeFeatures(read: Read, admin: boolean, hasScenarios: boolean): Promise<{ features: Features; operatorAgents: any[] }> {
  const settle = async <T,>(path: string, decide: (value: any) => T) => { try { return decide(await read(path)); } catch { return null; } };
  const [releases, validation, agents] = await Promise.all([
    settle('delivery', value => (value?.environments?.length ?? 0) + (value?.releases?.length ?? 0) > 0),
    settle('validation', value => hasScenarios || (value?.requests?.length ?? 0) > 0),
    admin ? settle('operator-agents', value => Array.isArray(value) ? value : null) : Promise.resolve([]),
  ]);
  return { features: { releases, validation, automation: admin ? agents === null ? null : agents.length > 0 : false }, operatorAgents: agents ?? [] };
}

/** Probes once per sign-in and then every minute; a newer probe never loses to an older one. */
export function useFeatures(token: string, ready: boolean, read: Read, admin: boolean, hasScenarios: boolean) {
  const [state, setState] = useState<{ features: Features; operatorAgents: any[] }>({ features: unknownFeatures, operatorAgents: [] });
  useEffect(() => {
    setState({ features: unknownFeatures, operatorAgents: [] });
    if (!token || !ready) return;
    let active = true;
    const load = () => void probeFeatures(read, admin, hasScenarios).then(next => { if (active) setState(next); });
    load(); const timer = setInterval(load, 60000);
    return () => { active = false; clearInterval(timer); };
  }, [token, ready, admin, hasScenarios]);
  return state;
}
