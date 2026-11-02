import type { FleetLaunchAccount } from './fleet.js';
import { LaunchRefusedError } from './harness.js';
/**
 * The role policy's tool allowlist on the runtime's tools flag. A policy that limits tools on a
 * runtime whose contract names no tools flag is refused, on the Herdr path and the headless one alike
 * (GY-397): guessing a flag the runtime may not know would start the session with every tool.
 */
export function registryToolsArgs(account: FleetLaunchAccount) {
  const { contract, policy } = account.fleet, tools = policy?.tools ?? [];
  if (!tools.length) return [];
  if (!contract.toolsFlag) throw new LaunchRefusedError(account.kind, `Graphyard refuses to launch account ${account.name}: role ${account.fleet.role ?? 'unknown'} limits its sessions to ${tools.join(', ')}, but runtime ${account.fleet.runtime} names no tools flag, so the session would run with every tool. Set it with master registry runtime set ${account.fleet.runtime} --tools-flag=FLAG.`);
  return [contract.toolsFlag, tools.join(',')];
}

