// Concern: cycle step 7c — the machine-filed backlog (GY-402): the one-time follow-up migration and the triage runs.
import { researchRunner, researchSettings } from '../research.js';
import { untriaged } from '../model/machine-backlog.js';
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
 * triages nothing, records that on its own actions while items wait, and each item is raised as
 * attention once it has waited a day.
 */
export async function triageBacklogStep(cycle: Cycle) {
  const { config, state, effects, now, snapshot, clock, performed, isolate } = cycle;
  const note = async (key: string, work: string | null, outcome: 'done' | 'failed' | 'waiting', detail: string) => {
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
  if (!effects.recordTriage) return;
  if (!effects.research || !config.run?.research) {
    // No fallback account: triage spends only the research account the operator named. Say so on the
    // loop's own record while anything waits (waiting, not a fault: nothing failed, and a fault class
    // would file a machine item of its own), rather than leaving the day-late attention as the only signal.
    const waiting = snapshot.work.filter(untriaged).map(item => item.key);
    if (waiting.length) await note('triage:unconfigured', null, 'waiting', `Triage is off: run.research does not name the research account, so ${waiting.length} machine-filed item${waiting.length === 1 ? '' : 's'} (${waiting.slice(0, 10).join(', ')}${waiting.length > 10 ? ', …' : ''}) wait unjudged; set run.research in graphyard.json, or judge each with graphyard master release|close`);
    return;
  }
  await isolate('decision', null, 'triage', async () => {
    const settings = researchSettings(config.run);
    const actions = triageStep({ work: snapshot.work, clock, settings, config, cwd: effects.research!.cwd, runner: effects.research!.runner ?? researchRunner(settings), record: effects.recordTriage! });
    for (const action of actions) {
      const item = snapshot.work.find(entry => entry.key === action.work)!;
      await note(`triage:${item.id}:${action.state}`, item.key, 'done', action.detail);
    }
  });
}
