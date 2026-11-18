// Concern: GY-3218 — an account whose agent says it is not logged in. A login file can outlive the
// login it names (Cursor keeps its profile in cli-config.json and its token elsewhere), so the probe
// reads such an account as logged in and every launch on it fails the same way. The agent's own
// message is the evidence: the account is held in the registry under it, and the launch moves to
// the role's next eligible account.
import { httpFleetClient, type FleetClient, type FleetProbe } from '../fleet.js';
import type { MasterConfig } from './profiles.js';
import { selectAccount, type LaunchSelection } from './environments.js';

export { detectLoggedOut } from './runtime-prompt.js';

type HoldConfig = Pick<MasterConfig, 'credentialFile'> & Partial<Pick<MasterConfig, 'url' | 'hostId'>>;
/**
 * Hold `account` in the registry as not logged in, with the agent's message as the reason. A probe
 * reading the same login does not lift the hold, since the probe is what misread it; a probe reading
 * another login, a passing smoke test, `master registry account quota NAME available` and changing
 * the account (`master registry account set`) do (GY-3441).
 */
export async function recordLoggedOut(config: HoldConfig, account: string, reason: string, registry?: Pick<FleetClient, 'observe'>) {
  const client = registry ?? (config.url ? httpFleetClient({ url: config.url, credentialFile: config.credentialFile }) : null);
  if (!client?.observe || !config.hostId) throw new Error('Holding a logged-out account requires the control-plane registry');
  await client.observe({ host: config.hostId, observations: [{ account, quota: { loggedIn: false, state: 'unknown', usage: [], resetsAt: null, reason: reason.slice(0, 500), session: 'login' } }] });
}

/**
 * How a headless launch leaves a logged-out account: hold it, give its registry session back, and
 * choose the role's next eligible account, which `launchOn` turns into the run's new launch.
 * `selection.current` follows the move, so whoever releases the session at the run's end releases
 * the one it ended on. With no account left the selection's own refusal ends the run.
 */
export function moveOffLoggedOutAccount<L>(config: HoldConfig & Pick<MasterConfig, 'environments' | 'run'>, profile: Parameters<typeof selectAccount>[2], work: string, selection: { current: LaunchSelection }, probe: FleetProbe | undefined, launchOn: (selected: LaunchSelection) => Promise<L>) {
  const tried = new Set(probe?.exclude ?? []);
  return async (reason: string, cause: 'login' | 'limit' | 'configuration' = 'login'): Promise<L> => {
    const account = selection.current.account?.name;
    if (!account) throw new Error(`the agent reported it is not logged in (${reason}), on no registry account to hold`);
    tried.add(account);
    if (cause === 'login') await recordLoggedOut(config, account, reason, probe?.registry);
    await selection.current.release?.(`${account}: ${reason}`.slice(0, 400)).catch(() => false);
    selection.current = { account: null, health: null, skipped: [] };
    try { selection.current = await selectAccount(config, 'reviewer', profile, { ...probe, work, exclude: [...tried] }); }
    catch (error) { throw new Error(`${reason}; ${error instanceof Error ? error.message : String(error)}`); }
    return launchOn(selection.current);
  };
}
