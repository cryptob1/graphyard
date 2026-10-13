// Concern: cycle step 7a' — the loop takes the reading a loop-owned post-deploy observation item owes, and closes the item it ends (GY-1762).
import { loopObservation, type Work } from '../model.js';
import { observationReading, patternOfProof, type PatternProjections } from '../model/observation-window.js';
import { detailChanged } from './decisions.js';
import { record } from './effects.js';
import { readyToRetry } from './sessions.js';
import { message } from './state.js';
import type { Cycle } from './cycle.js';

/** The action key of one observation item's reading: its epoch binds it, so an item taken up again is read again. */
export const observationKey = (item: Pick<Work, 'id' | 'epoch'>) => `observation:${item.id}:${item.epoch}`;

/**
 * GY-1762. An item that only owes a live reading is never a worker's: once the reading can exist
 * (`loopObservation().due`) the loop reads the intervention report for each proof's pattern, and
 * when every window has run it closes the item with the reading as the reason. What it cannot read
 * (a proof naming no pattern, a pattern not yet under its threshold, a window still running) stays
 * owed: the queue escalates it and the row says what is unread; the next cycle reads it again.
 */
export async function observationStep(cycle: Cycle) {
  const { state, effects, now, performed, isolate, open } = cycle;
  const { readPattern, closeObservation } = effects;
  if (!readPattern || !closeObservation) return;
  for (const item of open) {
    if (item.stage !== 'ready' || item.lease || !loopObservation(item, new Date(now()))?.due) continue;
    const key = observationKey(item), previous = state.actions[key];
    if (previous?.state === 'done' || (previous?.state === 'failed' && !readyToRetry(previous, state.cycle))) continue;
    await isolate('deployment', item, item.key, async () => {
      const note = async (outcome: 'done' | 'waiting' | 'failed', detail: string) => {
        if (outcome === 'waiting' && !detailChanged(previous, detail)) return;
        performed.push(await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: outcome, detail, attempts: outcome === 'failed' ? (previous?.state === 'failed' ? previous.attempts : 0) + 1 : 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
      };
      const projections: Record<string, PatternProjections[string]> = {};
      try {
        for (const proof of new Set(item.criteria.flatMap(criterion => criterion.proofs))) {
          const pattern = patternOfProof(proof.replace(/^manual:(.+)-on-serving-release$/, 'manual:post-deploy/$1'));
          if (pattern) projections[proof] = await readPattern(pattern);
        }
        const reading = observationReading(item, new Date(now()), projections);
        if (!reading.satisfied) return await note('waiting', `${item.key} owes its reading and the loop could not take it: ${reading.owed}`);
        if (await closeObservation(item, `${reading.reason}; ${item.key} owed only that reading, so the loop closes it`, `observation:close:${item.id}:${item.revision}`)) await note('done', `Closed ${item.key}: ${reading.reason}`);
      } catch (error) { await note('failed', `Could not take ${item.key}'s reading: ${message(error)}`); }
    });
  }
}
