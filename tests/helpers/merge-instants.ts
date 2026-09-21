// Provider merge instants for delivery tests, pinned to the instants the engine recorded rather
// than to how long the runner took between engine calls. The engine authorizes a merge only when
// its earliest repository-clock instant postdates the recorded commit and its cutoff still falls
// inside the execution window, so an instant derived from an earlier step plus an assumed
// elapsed time fails on a slow runner, on scheduling rather than on the behaviour under test.

export interface ClockOffset { min: number; max: number }

/**
 * The earliest provider timestamp, as GitHub would report it, of a merge the engine can attribute
 * to an execution committed at `committingAt` under a measured clock offset: its lower bound on
 * the repository clock (`mergedAt + offset.min`) is the first instant after the commit. GitHub
 * reports whole seconds; `millisecond` gives the exact instant for cases that need one.
 */
export function providerMergeInstant(committingAt: string, offset: ClockOffset = { min: 0, max: 0 }, precision: 'second' | 'millisecond' = 'second') {
  const earliest = Date.parse(committingAt) + 1 - offset.min;
  if (!Number.isFinite(earliest)) throw new Error(`No recorded commit instant to pin the merge to: ${committingAt}`);
  return precision === 'millisecond' ? new Date(earliest).toISOString() : new Date(Math.ceil(earliest / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

/** The instant after which the engine no longer attributes that merge: the engine's own cutoff. */
export function mergeCutoff(mergedAt: string, offset: ClockOffset = { min: 0, max: 0 }) {
  return Date.parse(mergedAt) + (/\.\d+Z$/.test(mergedAt) ? 1 : 1000) + offset.max;
}
