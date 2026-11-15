import type { DaemonState } from './state.js';

/** Gate flights share CPU slots with the merge/revert heads already recorded on daemon state. */
export const batchGateFlights = new WeakMap<object, { gate: Promise<void> | null; diagnostics: Promise<void> | null }>();
export const batchGateBusySlots = (state: object) => Number(!!batchGateFlights.get(state)?.gate) + Number(!!batchGateFlights.get(state)?.diagnostics);
/** Includes the starting trial, so it receives its share rather than the entire host. */
export const busyTrialSlots = (state: DaemonState) =>
  (state.mergeWriter.inFlights?.length ?? (state.mergeWriter.inFlight ? 1 : 0)) + batchGateBusySlots(state);
