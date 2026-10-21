// Concern: GY-2610 — the E2E fixtures a run left open are closed before anything releases or dispatches them.
import { installIdFor } from '../install/types.js';
import { e2ePrincipalId } from '../install/secrets.js';
import { deployInFlight } from './continuous-deploy.js';
import { record } from './effects.js';
import { message } from './state.js';
import type { Cycle } from './cycle.js';

/** The run and case an E2E case's item names in its title (`E2E case CASE run RUN …`), or null for any other title. */
const fixtureRun = (title: string) => /^E2E case (\S+) run (\S+)/.exec(title);

/**
 * GY-2610: every open item the install's E2E principal created is a fixture of the deployed E2E run
 * (GY-1982), never ordinary work. The run closes its own when it ends (GY-2216), but a run aborted,
 * killed at its timeout or ended by the shared wait deadline never reaches that cleanup; this step,
 * first in every cycle the loop runs while no deploy is in flight, closes what such a run left, as
 * obsolete with a reason naming the run, so nothing later in the cycle — or the operator — releases
 * or dispatches it: a closed item leaves the cycle's open set. Items whose run is still in flight
 * are its own to settle.
 */
export async function e2eFixtureStep(cycle: Cycle) {
  const { config, state, effects, now, performed, isolate, open } = cycle;
  if (!effects.closeWork || deployInFlight()) return;
  let principal: string;
  try { principal = e2ePrincipalId(installIdFor(config.repository)); } catch { return; }
  for (const item of open.filter(entry => entry.createdBy === principal)) await isolate('close', item, item.key, async () => {
    const named = fixtureRun(item.title), run = named ? `E2E run ${named[2]} (case ${named[1]})` : `an E2E run as ${principal}`;
    const key = `close:e2e-fixture:${item.id}`, attempts = (state.actions[key]?.attempts ?? 0) + 1;
    const note = async (outcome: 'done' | 'failed', detail: string) =>
      performed.push(await record(state, key, { kind: 'close', work: item.key, principal: null, state: outcome, detail, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
    try {
      await effects.closeWork!(item, { kind: 'obsolete', reason: `created by ${run}, which ended before closing its own work; an E2E fixture is never ordinary work` }, `e2e-fixture:${item.id}`);
      open.splice(open.indexOf(item), 1);
      await note('done', `Closed ${item.key} as obsolete: an E2E fixture ${run} left open`);
    } catch (error) { await note('failed', `Could not close ${item.key}, an E2E fixture ${run} left open: ${message(error)}`); }
  });
}

