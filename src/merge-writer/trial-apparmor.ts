// GY-3339: on an AppArmor host Docker confines a container with docker-default, which denies the
// mounts a nested bubblewrap sandbox makes ("Failed to make / slave"), and Ubuntu 24.04 and later
// deny unconfined processes a user namespace ("setting up uid map"). Trial containers alone run
// under a dedicated profile that is unconfined and grants userns; every other container keeps docker-default.
import { readFileSync } from 'node:fs';
import { shellQuote } from '../install/transport.js';

export const trialAppArmorProfile = 'graphyard-trial';
/** Under /etc/apparmor.d the host's apparmor service loads it again on every boot. */
export const trialAppArmorProfilePath = `/etc/apparmor.d/${trialAppArmorProfile}`;
export const trialAppArmorProfileText = `abi <abi/4.0>,
include <tunables/global>

# Graphyard merge-trial containers: the container is the boundary (read-only root, no capabilities,
# no new privileges); its tests start nested sandboxes, which need mounts and a user namespace.
profile ${trialAppArmorProfile} flags=(unconfined) {
  userns,
}
`;
/** Whether the host enforces AppArmor; GRAPHYARD_APPARMOR_ENABLED_FILE stands in for the kernel's answer. */
export function appArmorEnabled(file = process.env.GRAPHYARD_APPARMOR_ENABLED_FILE || '/sys/module/apparmor/parameters/enabled'): boolean {
  try { return readFileSync(file, 'utf8').trim().startsWith('Y'); } catch { return false; }
}
/** The commands that install and load the trial profile, as one shell line. */
export const trialAppArmorLoadCommand = `printf %s ${shellQuote(trialAppArmorProfileText)} | sudo tee ${trialAppArmorProfilePath} >/dev/null && sudo apparmor_parser -r -W ${trialAppArmorProfilePath}`;
/** The fix doctor and a sandbox trial-host fault name. */
export const trialAppArmorFix = `rerun graphyard up, which writes the ${trialAppArmorProfile} AppArmor profile to ${trialAppArmorProfilePath} and loads it (sudo apparmor_parser -r -W ${trialAppArmorProfilePath})`;
/** What a nested sandbox prints when AppArmor denies it inside a trial container. */
export const nestedSandboxDenied = /bwrap: (?:Failed to make \/ slave|setting up uid map): Permission denied/;
