// Concern: the production wiring of the loop's own post-deploy readings (GY-1779) — recorded and closed with the coordinator credential, the parent's check through the filer verify-deployment uses.
import type { MasterConfig } from '../master.js';
import type { ReadingEffects } from './cycle-readings.js';
export type { ReadingEffects } from './cycle-readings.js';

/**
 * The reading effects over the loop's coordinator calls. The filer and the readers are loaded at
 * call time: master-verification.ts imports the daemon, so a static import here would be a cycle.
 */
export function readingEffects(current: () => MasterConfig, mutate: (path: string, data: unknown, requestId?: string) => Promise<unknown>): Required<ReadingEffects> {
  const verification = () => import('../master-verification.js');
  return {
    recordReading: (work, reading) => mutate(`work/${work.id}/reading`, reading),
    closeObservation: (work, release, reason, key) => mutate(`work/${work.id}/close`, { kind: 'delivered-observation', ref: release, reason }, key),
    // The filer of the serving release, as verify-deployment resolves it: a parent proof is accepted by the code the release carries, never by the coordinator checkout's when they differ.
    postDeployFiler: async input => {
      const { releasePostDeployFiler } = await verification();
      const resolved = await releasePostDeployFiler(current(), input.release);
      if ('reason' in resolved) throw new Error(resolved.reason);
      try { return await resolved.filer(input); } finally { await resolved.dispose(); }
    },
    readPostDeploy: async input => (await import('../master/post-deploy-readings.js')).postDeployReader(current().cliPath)(input),
  };
}
