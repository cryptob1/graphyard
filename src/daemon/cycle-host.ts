// Concern: cycle step 2c2 — the host's systemd user manager revived and its declared executor slots started (GY-1428).
import { record } from './effects.js';
import { detailChanged } from './decisions.js';
import { loopUnitName } from '../supervisor.js';
import type { Cycle } from './cycle.js';

export const hostSupervisionKey = 'host-supervision';
/** The loop's own unit found inactive while the manager answers: reported once, never started (a hand-started loop would meet a second one). */
export const hostLoopUnitKey = `${hostSupervisionKey}:loop`;
export const hostSlotKey = (unit: string) => `${hostSupervisionKey}:${unit}`;
const minute = 60_000;
/** The wait before the next `loginctl enable-linger`, after `revivals` that left the manager silent: 1, 2, 4 … minutes, at most 30. */
export const reviveBackoffMs = (revivals: number) => Math.min(2 ** Math.max(0, revivals - 1), 30) * minute;
/** A slot the loop started is not started again within this long of it; a slot down again sooner waits. */
export const slotCooldownMs = 10 * minute;
/** Restarts of one slot within `slotWindowMs` before the loop stops restarting it and reports it failed. */
export const maxSlotRestarts = 3;
export const slotWindowMs = 60 * minute;

/**
 * Step 2c2, before the blocker probes read the host. A revival that leaves the manager silent is one
 * failing run of `host-supervision`, however many slots and blockers it holds, and logind is asked
 * again only after `reviveBackoffMs`, so a manager that stays down costs no cycle the few seconds a
 * revival waits. Each slot the loop starts is a `host-supervision:UNIT` row: a slot down again
 * within `slotCooldownMs` waits, and a slot down a fourth time within the hour is reported failed
 * and left down until it is seen running. A slot an operator disabled is never started. A host with
 * nothing to repair records nothing.
 */
export async function hostSupervisionStep(cycle: Cycle) {
  const { effects, state, now, performed } = cycle;
  if (!effects.healHostSupervision) return;
  const at = now(), actions = state.actions, previous = actions[hostSupervisionKey];
  const failing = previous?.state === 'failed', since = (key: string) => at - Date.parse(actions[key]?.at ?? '');
  const revive = !failing || !previous.attempts || since(hostSupervisionKey) >= reviveBackoffMs(previous.attempts);
  const restart = (unit: string) => { const row = actions[hostSlotKey(unit)]; return !row || (row.state !== 'failed' && since(hostSlotKey(unit)) >= slotCooldownMs && !(row.attempts >= maxSlotRestarts && since(hostSlotKey(unit)) < slotWindowMs)); };
  const heal = await effects.healHostSupervision({ revive, restart });
  // A `waiting` row is a report, not a failure: it carries no fault.
  const note = async (key: string, outcome: 'done' | 'failed' | 'waiting', detail: string, attempts: number, kept?: string) =>
    performed.push(await record(state, key, { kind: 'config', work: null, principal: null, state: outcome, detail, attempts, cycle: state.cycle, ...(kept ? { at: kept } : {}) }, at, effects.persist, outcome === 'waiting' ? null : undefined));
  if (heal.reason) {
    const detail = `${heal.performed.length ? `${heal.performed.join('; ')}; but ` : ''}${heal.reason}`;
    // A cycle that withheld the revival keeps the run's clock, so the backoff counts from the last revival.
    if (heal.revived) await note(hostSupervisionKey, 'failed', detail, (failing ? previous.attempts : 0) + 1);
    else if (detailChanged(previous, detail)) await note(hostSupervisionKey, 'failed', detail, failing ? previous.attempts : 0, failing ? previous.at : undefined);
  } else if (heal.revived || failing) {
    await note(hostSupervisionKey, 'done', heal.revived ? `Repaired this host's supervision: ${heal.performed[0]}` : 'The systemd user manager answers again', 1);
  }
  for (const slot of heal.down) {
    const key = hostSlotKey(slot.unit), row = actions[key], recent = !!row && since(key) < slotWindowMs;
    if (slot.outcome === 'disabled') { if (row) delete actions[key]; continue; }
    if (slot.outcome === 'started') await note(key, 'done', `Started ${slot.unit} (slot ${slot.slot} was ${slot.active})`, recent ? row.attempts + 1 : 1);
    else if (row && row.state !== 'failed' && recent && row.attempts >= maxSlotRestarts)
      await note(key, 'failed', `Executor slot ${slot.slot} is ${slot.active} again after ${row.attempts} restarts within ${slotWindowMs / minute} minutes; the loop no longer restarts it: journalctl --user -u ${slot.unit} says why, and once it runs again the loop restarts it as before`, row.attempts, row.at);
  }
  // A slot seen running ends its failing run; a quiet row ages out once its window has passed.
  for (const unit of heal.up) {
    const key = hostSlotKey(unit), row = actions[key];
    if (row?.state === 'failed') await note(key, 'done', `${unit} runs again`, 1);
    else if (row && since(key) >= slotWindowMs) { delete actions[key]; await effects.persist(state); }
  }
  if (heal.loop && heal.loop !== 'active') {
    const detail = `The systemd user manager answers, but the loop's unit is ${heal.loop}: this loop runs outside it, so the host stays unsupervised until the loop is stopped and its unit started (systemctl --user enable --now ${loopUnitName}); the loop never starts it under itself, which would run a second loop`;
    if (detailChanged(actions[hostLoopUnitKey], detail)) await note(hostLoopUnitKey, 'waiting', detail, 1);
  } else if (heal.loop && actions[hostLoopUnitKey]) { delete actions[hostLoopUnitKey]; await effects.persist(state); }
}
