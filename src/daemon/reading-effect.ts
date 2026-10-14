// Concern: the production wiring of the loop's own post-deploy readings (GY-1779) — recorded and closed with the coordinator credential, the parent's check through the filer verify-deployment uses, the report's rows through the coordinator read.
import type { MasterConfig } from '../master.js';
import type { ReadingEffects } from './cycle-readings.js';
export type { ReadingEffects } from './cycle-readings.js';

/**
 * The reading effects over the loop's coordinator calls. The filer and the readers are loaded at
 * call time: master-verification.ts imports the daemon, so a static import here would be a cycle.
 */
export function readingEffects(current: () => MasterConfig, mutate: (path: string, data: unknown, requestId?: string) => Promise<unknown>, asCoordinator: (path: string) => Promise<unknown>): Required<ReadingEffects> {
  const verification = () => import('../master-verification.js');
  return {
    recordReading: (work, reading) => mutate(`work/${work.id}/reading`, reading),
    closeObservation: (work, release, reason, key) => mutate(`work/${work.id}/close`, { kind: 'delivered-observation', ref: release, reason }, key),
    postDeployFiler: async input => (await verification()).localPostDeployChecks(input),
    readPattern: async pattern => (await verification()).patternReader(asCoordinator)(pattern),
    readPostDeploy: async input => (await import('../master/post-deploy-readings.js')).postDeployReader((await verification()).patternReader(asCoordinator), current().cliPath)(input),
  };
}
