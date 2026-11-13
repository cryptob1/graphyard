// Concern: the worker pool follows the registry's worker role (GY-3285).
import { dirname, join } from 'node:path';
import { atomicPrivateText } from '../private-file.js';
import { roleLimit } from '../model/registry.js';
import { saveWorkerProfile } from './config.js';
import { MAX_WORKER_PROFILES, type MasterConfig, type WorkerProfile } from './profiles.js';

/**
 * How many worker sessions the install runs at once: the registry worker role's accounts times its
 * concurrency, set with `master workers N`. An install whose registry names no worker role runs
 * one per configured worker profile, as before.
 */
export function workersAllowed(config: Pick<MasterConfig, 'workers'>, registry: { roles: { name: string; accounts: readonly string[]; concurrency: number }[] } | null | undefined) {
  const role = registry?.roles.find(entry => entry.name === 'worker');
  return role ? roleLimit(role) : config.workers.length;
}

/**
 * Adds launch profiles until `allowed` exist, each a copy of the first under its own worker
 * identity: `mint` asks the control plane for the identity's token, which is written beside the
 * first profile's credential. Profiles are only ever added, so a lowered limit leaves the spare
 * ones idle and a raised one reuses them. Growth stops at MAX_WORKER_PROFILES profiles of any mode
 * (GY-3292): past it master.json would be unreadable and every cycle would mint another identity.
 */
export async function growWorkerPool(root: string, config: Pick<MasterConfig, 'workers'>, allowed: number, mint: (id: string) => Promise<{ token: string }>) {
  const first = config.workers.find(profile => profile.mode === 'launch' && profile.credentialFile);
  const added: WorkerProfile[] = [];
  for (let n = 2; first && config.workers.length < MAX_WORKER_PROFILES && config.workers.filter(profile => profile.mode === 'launch').length < allowed; n++) {
    const profile: WorkerProfile = { ...first, name: `${first.name}-${n}`, principal: `${first.principal}-${n}`, agentName: `${first.agentName}-${n}` };
    if (config.workers.some(other => other.name === profile.name || other.principal === profile.principal || other.agentName === profile.agentName)) continue;
    profile.credentialFile = join(dirname(first.credentialFile!), `${profile.principal}.token`);
    await atomicPrivateText(profile.credentialFile, (await mint(profile.principal)).token);
    await saveWorkerProfile(root, profile, async () => ({ actor: { id: profile.principal, role: 'worker' } }));
    config.workers.push(profile); added.push(profile);
  }
  return added;
}
