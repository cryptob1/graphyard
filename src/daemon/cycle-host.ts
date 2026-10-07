// Concern: cycle step 2c' — the host's systemd user manager revived and its declared executor slots started (GY-1428).
import { record } from './effects.js';
import type { Cycle } from './cycle.js';

export const hostSupervisionKey = 'host-supervision';

/**
 * Step 2c', before the blocker probes read the host. A repair the loop made is recorded as done;
 * one it could not make is one failing run of the action, so a manager that stays down is one
 * configuration instance however many slots and blockers it holds, and the run ends with the
 * first cycle that finds the manager answering again. A host with nothing to repair records nothing.
 */
export async function hostSupervisionStep(cycle: Cycle) {
  const { effects, state, now, performed } = cycle;
  if (!effects.healHostSupervision) return;
  const heal = await effects.healHostSupervision();
  const previous = state.actions[hostSupervisionKey];
  if (!heal.performed.length && !heal.reason && previous?.state !== 'failed') return;
  const attempts = heal.reason ? (previous?.state === 'failed' ? previous.attempts : 0) + 1 : 1;
  const detail = heal.reason ? `${heal.performed.length ? `${heal.performed.join('; ')}; but ` : ''}${heal.reason}`
    : heal.performed.length ? `Repaired this host's supervision: ${heal.performed.join('; ')}` : 'The systemd user manager answers and every declared executor slot is up again';
  performed.push(await record(state, hostSupervisionKey, { kind: 'config', work: null, principal: null, state: heal.reason ? 'failed' : 'done', detail, attempts, cycle: state.cycle }, now(), effects.persist));
}
