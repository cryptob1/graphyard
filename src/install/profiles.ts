import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadMasterConfig, saveWorkerProfile, setupMaster } from '../master.js';
import { setupRepository } from '../repository-setup.js';
import type { ProfileRegistration, ProfileRequest } from './index.js';

/**
 * Registers the operating profiles on this machine. Each session receives exactly one
 * credential: the worker profiles point at per-worker token files, the master reads the
 * coordinator token from the installation directory, and no profile embeds a secret.
 */
export async function registerLocalProfiles(request: ProfileRequest): Promise<ProfileRegistration> {
  const registration: ProfileRegistration = {
    repository: { connected: false, herdr: false, detail: 'not attempted' },
    master: { configured: false, kind: request.masterKind, detail: 'not attempted' },
    workers: [], reviewers: request.reviewers,
  };

  const worker = request.workerTokens[0];
  if (worker) {
    try {
      const result = await setupRepository(request.root, { url: request.url, cliPath: request.cliPath, hostId: request.hostId, token: worker.token }, { herdr: request.herdr.available, ...(request.runHerdr ? { runHerdr: request.runHerdr } : {}) });
      registration.repository = { connected: result.connected, herdr: result.pluginConfigured, detail: result.pluginConfigured ? 'repository connected and the Herdr plugin is linked and enabled' : `repository connected; ${request.herdr.reason}` };
    } catch (error: any) { registration.repository = { connected: false, herdr: false, detail: `repository setup did not complete: ${error.message}` }; }
  }

  try {
    await setupMaster(request.root, { url: request.url, token: request.coordinatorToken, cliPath: request.cliPath, hostId: request.hostId, credentialDirectory: request.installDirectory });
    registration.master = { configured: true, kind: request.masterKind, detail: request.masterKind ? `run: graphyard master start ${request.masterKind}` : 'no authenticated agent runtime was detected for the master session' };
  } catch (error: any) { registration.master = { configured: false, kind: request.masterKind, detail: `master setup did not complete: ${error.message}` }; }

  if (registration.master.configured) {
    let existing: string[] = [];
    try { existing = (await loadMasterConfig(request.root)).workers.map(profile => profile.name); } catch { existing = []; }
    for (const profile of request.workers) {
      if (existing.includes(profile.name)) { registration.workers.push({ name: profile.name, principal: profile.principal, kind: profile.kind }); continue; }
      try {
        await saveWorkerProfile(request.root, profile, async token => {
          const response = await fetch(`${request.url}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error(`Graphyard rejected the worker credential (${response.status})`);
          return response.json();
        });
        registration.workers.push({ name: profile.name, principal: profile.principal, kind: profile.kind });
      } catch { /* a runtime that cannot be registered is reported by its absence, never by a partial profile */ }
    }
  }

  if (request.reviewers.length) {
    // Reviewer profiles carry no credential: they name a reviewer App and its runtime.
    await writeFile(resolve(request.installDirectory, 'reviewer-profiles.json'), `${JSON.stringify(request.reviewers, null, 2)}\n`, { mode: 0o600 });
  }
  return registration;
}
