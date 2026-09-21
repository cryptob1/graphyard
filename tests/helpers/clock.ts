/**
 * Pinned instants for cases about merge authority (GY-95).
 *
 * The engine judges a provider merge against instants it recorded itself — the execution's
 * `committingAt` and `expiresAt`, carried across the measured clock offset. A test that derives the
 * merge instant from an earlier instant plus the time the runner happened to take between two engine
 * calls is measuring the runner: on a slow one the derived instant lands before the recorded commit
 * and the engine correctly refuses a delivery the case never meant to question. These helpers pin
 * every asserted instant to the record instead, so the case reads the same however long each call took.
 */

/** A whole-second provider timestamp, as GitHub reports merges, strictly after `instantMs`. */
export function wholeSecondAfter(instantMs: number): string {
  return new Date(Math.ceil((instantMs + 1) / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * The earliest whole-second instant GitHub can report a merge that the engine attributes to a
 * committed execution: on the repository clock, `mergedAt + clockOffset.min` must postdate the
 * recorded `committingAt`. Pinned to the record, not to when the test reached this line.
 */
export function providerMergeInstant(committingAt: string, clockOffset: { min: number; max: number } = { min: 0, max: 0 }): string {
  return wholeSecondAfter(Date.parse(committingAt) - clockOffset.min);
}
