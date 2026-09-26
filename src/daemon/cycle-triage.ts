// Concern: cycle step 7c — the machine-filed backlog (GY-402): the one-time follow-up migration and the triage runs.
import { researchRunner, researchSettings } from '../research.js';
import { triageStep } from '../triage.js';
import { detailChanged } from './decisions.js';
import { record } from './effects.js';
import { message } from './state.js';
import type { Cycle } from './cycle.js';

/** Whether this process has had the control plane run the one-time follow-up migration; the server makes a repeat a no-op either way. */
let migrated = false;
/** Test seam: forget that the migration ran. */
export function resetFollowUpMigration() { migrated = false; }

/**
 * Step 7c. Once per loop process, ask the control plane for the one-time migration that folds each
 * parent's duplicate follow-up items into its oldest open one. Then start a triage run for each
 * machine-filed item awaiting triage, on the research account (`run.research`): an unconfigured loop
 * triages nothing, and the item is raised as attention once it has waited a day.
 */
export async function triageBacklogStep(cycle: Cycle) {
  const { config, state, effects, now, snapshot, clock, performed, isolate } = cycle;
  const note = async (key: string, work: string | null, outcome: 'done' | 'failed', detail: string) => {
    if (!detailChanged(state.actions[key], detail)) return;
    performed.push(await record(state, key, { kind: 'decision', work, principal: null, epoch: null, state: outcome, detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  };
  if (!migrated && effects.migrateFollowUps) await isolate('decision', null, 'follow-up migration', async () => {
    try {
      const result = await effects.migrateFollowUps!();
      migrated = true;
      await note('followups:migration', null, 'done', result.already ? `The one-time follow-up migration already ran (${result.merged} duplicate follow-up items merged into their parent's oldest open one)` : `Merged ${result.merged} duplicate follow-up items into their parent's oldest open follow-up item and closed them as superseded by it`);
    } catch (error) { await note('followups:migration', null, 'failed', `The one-time follow-up migration could not run, and is asked again next cycle: ${message(error)}`); }
  });
  if (!effects.recordTriage || !effects.research || !config.run?.research) return;
  await isolate('decision', null, 'triage', async () => {
    const settings = researchSettings(config.run);
    const actions = triageStep({ work: snapshot.work, clock, settings, config, cwd: effects.research!.cwd, runner: effects.research!.runner ?? researchRunner(settings), record: effects.recordTriage! });
    for (const action of actions) {
      const item = snapshot.work.find(entry => entry.key === action.work)!;
      await note(`triage:${item.id}:${action.state}`, item.key, 'done', action.detail);
    }
  });
}
