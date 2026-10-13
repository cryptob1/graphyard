// Concern: the effects that take an owed post-deploy observation's reading and close the item it ended (GY-1762) — the interface and its production wiring.
import type { Work } from '../model.js';
import type { MasterConfig } from '../master.js';
import { patternReader } from '../master-verification.js';
import type { PatternReader } from '../model/observation-window.js';

export interface ObservationEffects {
  /** The intervention report's reading for one pattern (the coordinator credential reads it); absent, the loop takes no reading. */
  readPattern?: PatternReader;
  /** Closes a loop-owned observation item as the operator-agent once the loop has read what it owed; null, closing nothing, without that identity. */
  closeObservation?: (item: Work, reason: string, key: string) => Promise<Work | null>;
}

export function observationEffects(current: () => MasterConfig, asCoordinator: (path: string) => Promise<unknown>,
  asOperatorAgent: (method: 'POST', path: string, body: unknown, key: string) => Promise<unknown>): Required<ObservationEffects> {
  return {
    readPattern: patternReader(path => asCoordinator(path)),
    // The identity is read on each call, as a configuration reload may provision it after the loop starts.
    closeObservation: async (item, reason, key) => current().operatorAgent ? asOperatorAgent('POST', `work/${item.id}/close`, { kind: 'obsolete', reason }, key) as Promise<Work> : null,
  };
}
