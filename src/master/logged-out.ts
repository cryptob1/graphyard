// Concern: GY-3218 — an account whose agent says it is not logged in. A login file can outlive the
// login it names (Cursor keeps its profile in cli-config.json and its token elsewhere), so the probe
// reads such an account as logged in and every launch on it fails the same way. The agent's own
// message is the evidence: the account is held in the registry under it, and the launch moves to
// the role's next eligible account.
import { httpFleetClient, type FleetClient, type FleetProbe } from '../fleet.js';
import type { MasterConfig } from './profiles.js';
import { selectAccount, type LaunchSelection } from './environments.js';

/**
 * Each runtime's not-logged-in message, as its one-shot form prints it before exiting non-zero:
 * Cursor ("Authentication required. Please run 'agent login' first"), Claude Code ("Not logged in ·
 * Please run /login", "Invalid API key · Please run /login"), Codex ("Not logged in", "run codex
 * login"), OpenCode ("opencode auth login") and Pi ("No API key found").
 */
const loggedOutMessage = /authentication required|not logged in|not authenticated|please run .{0,20}login|(codex|agent|auth) login|no api key found/i;
/** The line of a failed run's output that says its account is not logged in, or null. Only short output is read: a login refusal is the whole of what the agent printed, never a line inside its work. */
export function detectLoggedOut(output: string): string | null {
  if (output.length > 4000) return null;
  const line = output.split('\n').map(text => text.trim()).find(text => loggedOutMessage.test(text));
  return line ? line.slice(0, 300) : null;
}

type HoldConfig = Pick<MasterConfig, 'credentialFile'> & Partial<Pick<MasterConfig, 'url' | 'hostId'>>;
/**
 * Hold `account` in the registry as not logged in, with the agent's message as the reason. No probe
 * lifts the hold, since the probe is what misread the login: `master registry account quota NAME
 * available` clears it, and so does changing the account (`master registry account set`).
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
  return async (reason: string): Promise<L> => {
    const account = selection.current.account?.name;
    if (!account) throw new Error(`the agent reported it is not logged in (${reason}), on no registry account to hold`);
    await recordLoggedOut(config, account, reason, probe?.registry);
    await selection.current.release?.(`${account} is not logged in: ${reason}`.slice(0, 400)).catch(() => false);
    selection.current = { account: null, health: null, skipped: [] };
    selection.current = await selectAccount(config, 'reviewer', profile, { ...probe, work });
    return launchOn(selection.current);
  };
}
