import type { DaemonState } from './state.js';

/** Gate flights share CPU slots with the merge/revert heads already recorded on daemon state. */
export const batchGateFlights = new WeakMap<object, { gate: Promise<void> | null; diagnostics: Promise<void> | null; /** GY-3518: the gate's check waits for its slot. */ waiting?: () => boolean }>();
/** GY-3444: a gate run is in flight, so new implementation sessions wait for it to settle. GY-3518: not while it only waits for a slot. */
export const batchGateRunning = (state: object) => { const flight = batchGateFlights.get(state); return !!flight?.gate && !flight.waiting?.(); };
export const batchGateBusySlots = (state: object) => Number(!!batchGateFlights.get(state)?.gate) + Number(!!batchGateFlights.get(state)?.diagnostics);
/** Includes the starting trial, so it receives its share rather than the entire host. */
export const busyTrialSlots = (state: DaemonState) =>
  (state.mergeWriter.inFlights?.length ?? (state.mergeWriter.inFlight ? 1 : 0)) + batchGateBusySlots(state);
