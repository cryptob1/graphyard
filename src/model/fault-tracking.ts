// Concern: when the loop's fault record began (GY-374). The record itself — which observations are one standing
// fault, when one ends, each failing action's run — is fault-record.ts; this adds only its `since` and `baseline`.
import type { FaultInstance, FaultObservation } from './fault-classes.js';
import { trackFaults as trackStanding, type FaultRecord as StandingRecord } from './fault-record.js';

export { noteActionOutcome, noteFault, retainedFaultInstances } from './fault-record.js';

/**
 * The loop's record, and `since`, the first cycle that read every source (GY-374). Until then the record has no past to
 * compare with, so what it finds standing is marked `baseline`: already wrong before tracking began, not an occurrence
 * inside the window.
 */
export interface FaultRecord extends StandingRecord { since?: string | null }

/**
 * One cycle's observations against the record, as fault-record.ts tracks them. What opens before the record's first
 * complete cycle is `baseline`: a fresh record, a new coordinator or the release that starts tracking finds every
 * standing fault at once, and those are the installation's state, not recurrences.
 */
export function trackFaults(record: FaultRecord, observations: readonly FaultObservation[], at: string, partial: boolean | ReadonlySet<string> = false): FaultInstance[] {
  // A record kept before GY-374 has no `since`, and one with a fault standing (none of them baseline) has tracked since its first instance.
  if (!record.since && Object.keys(record.open).length && !record.instances.some(entry => entry.baseline)) record.since = record.instances[0]?.at ?? at;
  const baseline = !record.since, opened = trackStanding(record, observations, at, partial);
  if (baseline) { for (const instance of opened) instance.baseline = true; if (partial !== true) record.since = at; }
  return opened;
}
