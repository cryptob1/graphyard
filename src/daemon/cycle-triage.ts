// Concern: cycle step 7c — the machine-filed backlog (GY-402): the triage runs; the goals the acceptance role drafts (GY-1417) and the planner plans (GY-1418).
import { researchRunner, researchSettings } from '../research.js';
import { triageStep } from '../triage.js';
import { detailChanged } from './decisions.js';
import { record } from './effects.js';
import { acceptanceStep } from './acceptance.js';
import { plannerStep } from './planner.js';
import type { Cycle } from './cycle.js';

/**
 * Step 7c. Start a triage run for each machine-filed item awaiting triage, on the research account (`run.research`): an unconfigured loop
 * triages nothing, and the item is raised as attention once it has waited a day.
 */
export async function triageBacklogStep(cycle: Cycle) {
  const { config, state, effects, now, snapshot, clock, performed, isolate } = cycle;
  const note = async (key: string, work: string | null, outcome: 'done' | 'failed', detail: string) => {
    if (!detailChanged(state.actions[key], detail)) return;
    performed.push(await record(state, key, { kind: 'decision', work, principal: null, epoch: null, state: outcome, detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  };
  // The acceptance role's goals (GY-1417) move first: they need no research account.
  await acceptanceStep(cycle);
  // A goal whose acceptance merged is planned, its plan judged, released and delivered (GY-1418).
  await plannerStep(cycle);
  if (!effects.recordTriage || !effects.research || !config.run?.research) return;
  await isolate('decision', null, 'triage', async () => {
    const settings = researchSettings(config.run);
    const actions = triageStep({ work: snapshot.work, clock, settings, config, cwd: effects.research!.cwd, runner: effects.research!.runner ?? researchRunner(settings), record: effects.recordTriage!, faults: state.faults });
    for (const action of actions) {
      const item = snapshot.work.find(entry => entry.key === action.work)!;
      await note(`triage:${item.id}:${action.state}`, item.key, 'done', action.detail);
    }
  });
}
