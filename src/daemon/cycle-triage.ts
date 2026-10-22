// Concern: cycle step 7c — the machine-filed backlog (GY-402): the triage runs; the goals the acceptance role drafts (GY-1417) and the planner plans (GY-1418).
import { researchRunner, researchSettings } from '../research.js';
import { triageStep, type TriageStepInput } from '../triage.js';
import { detailChanged } from './text.js';
import { record } from './effects.js';
import { acceptanceStep } from './acceptance.js';
import { plannerStep } from './planner.js';
import type { Cycle } from './cycle.js';
import type { Work } from '../model.js';
import { boundedCalls, boundedPhase, carriedRow, recordCarried, stepCallBoundMs, stepCallCarried, unboundedEffects, withinStepBudget } from './step-budget.js';

/**
 * Step 7c. Start a triage run for each machine-filed item awaiting triage, on the research account (`run.research`): an unconfigured loop
 * triages nothing, and the item is raised as attention once it has waited a day.
 */
export const triageBacklogStep = (cycle: Cycle) => withinStepBudget(cycle, 'triage', ['recordTriage'], triageBacklogStepWithin); // GY-1774: the triage record is bounded
async function triageBacklogStepWithin(cycle: Cycle, budgetLeft: () => number | null) {
  const { config, state, effects, now, snapshot, clock, performed, isolate } = cycle;
  const note = async (key: string, work: string | null, outcome: 'done' | 'failed', detail: string) => {
    if (!detailChanged(state.actions[key], detail)) return;
    performed.push(await record(state, key, { kind: 'judgement', work, principal: null, epoch: null, state: outcome, detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  };
  // The acceptance role's goals (GY-1417) move first: they need no research account.
  // GY-1774: both phases wait under the step's budget; a slow answer is carried and joined next cycle, never holding the phases after it.
  await boundedPhase(cycle, 'triage', 'acceptance', budgetLeft, phase => acceptanceStep(phase));
  // A goal whose acceptance merged is planned, its plan judged, released and delivered (GY-1418).
  await boundedPhase(cycle, 'triage', 'planner', budgetLeft, phase => plannerStep(phase));
  if (!effects.recordTriage || !effects.research || !config.run?.research) return;
  await isolate('judgement', null, 'triage', async () => {
    const settings = researchSettings(config.run);
    // GY-1774: a record the step makes is bounded by the step and awaited within it, so a carried one is recorded `waiting` on
    // the item's row; one a run settling after the step makes holds no cycle but is bounded by the per-call bound alone, so a
    // hanging plane never holds it either. Either, carried, stays owed to triage (`carried`), which records it again next cycle,
    // joining the write still in flight or consuming its answer — applied once, and the item is never judged again meanwhile.
    let running = true;
    const writes: Promise<unknown>[] = [];
    const later = boundedCalls(unboundedEffects(effects), state, now, () => stepCallBoundMs, { step: 'triage', calls: ['recordTriage'] }).recordTriage!;
    const recordKey = (work: Work) => `triage:${work.id}:record`;
    const within: TriageStepInput['record'] = async (work, body) => {
      const key = recordKey(work), carried = state.actions[key];
      try { await effects.recordTriage!(work, body); }
      catch (error) {
        if (stepCallCarried(error)) await recordCarried(cycle, key, { kind: 'judgement', work: work.key }, error, `Recording the triage judgement of ${work.key}`);
        throw error;
      }
      if (carriedRow(carried)) performed.push(await record(state, key, { kind: 'judgement', work: work.key, principal: null, epoch: null, state: 'done', detail: `Recorded the triage judgement of ${work.key} (${body.judgement.outcome}) whose write was carried from an earlier cycle`, attempts: carried!.attempts, cycle: state.cycle }, now(), effects.persist));
    };
    const recordTriage: TriageStepInput['record'] = (work, body) => { if (!running) return later(work, body); const write = within(work, body); writes.push(write); return write; };
    try {
      const actions = triageStep({ work: snapshot.work, clock, settings, config, cwd: effects.research!.cwd, runner: effects.research!.runner ?? researchRunner(settings), record: recordTriage, carried: stepCallCarried });
      for (const action of actions) {
        const item = snapshot.work.find(entry => entry.key === action.work)!;
        await note(`triage:${item.id}:${action.state}`, item.key, 'done', action.detail);
      }
      await Promise.allSettled(writes);
    } finally { running = false; }
  });
}
