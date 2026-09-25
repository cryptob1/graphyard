import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationBand, observationCadence, observationCadenceMs } from '../src/github.js';
import { reworkObservationMaxAgeMs } from '../src/master-daemon.js';
import type { Observation, Work } from '../src/model.js';
import type { NextAction } from '../src/model/action-kinds.js';

/**
 * 2026-09-25: GY-173, GY-177 and GY-182 were ejected from the merge queue for conflicts and sat
 * there for over an hour. The loop asks for their rework only from an observation under two
 * minutes old (GY-144), but an item needing a rework was observed on the idle band — or the
 * steady one once unchanged — never less than two minutes apart, so every cycle read "rework
 * waits for a fresh GitHub observation". The cadence of such an item must stay under that bound.
 */
const observation = { at: '2026-09-25T12:00:00.000Z', candidate: { sha: 'a'.repeat(40) }, merged: false, prState: 'open', checks: [], reviews: [] } as unknown as Observation;
const work = { key: 'GY-1', candidate: { sha: 'a'.repeat(40), pr: 1 }, observation, gates: [{ name: 'review', passed: false }] } as unknown as Work;
const next = (kind: NextAction['kind']) => ({ kind }) as unknown as NextAction;
const now = new Date('2026-09-25T12:00:30.000Z');

test('unit:rework-observed-within-decision-bound — an item whose next action is a rework is observed faster than the loop\'s rework freshness bound, even when unchanged and under a stretched fleet bound', () => {
  assert.equal(observationBand(work, [work], now, next('request-rework')).band, 'active');
  for (const steadyMs of [observationCadenceMs.steady, 600_000]) {
    const cadence = observationCadence(work, [work], now, observation, steadyMs, next('request-rework'));
    assert.equal(cadence.band, 'active', 'an unchanged rework-bound item is not settled to the steady band');
    assert.ok(cadence.ms < reworkObservationMaxAgeMs, `observed every ${cadence.ms}ms, inside the ${reworkObservationMaxAgeMs}ms bound the rework decision needs`);
  }
  // Dispatch and escalation stay idle: nothing observed on GitHub moves them.
  for (const kind of ['dispatch', 'escalate'] as const) assert.equal(observationBand(work, [work], now, next(kind)).band, 'idle');
  // Any other active item that came back unchanged still settles to the steady band.
  assert.equal(observationCadence(work, [work], now, observation, observationCadenceMs.steady, next('request-review')).band, 'steady');
});
