import { appendGoal, applyGoalCommand, type Goal } from '../../src/model/goal.js';
import { type GoalPlan, planItemInput, planOrder } from '../../src/model/goal-plan.js';
import type { Work } from '../../src/model.js';
import type { PlannerEffects } from '../../src/daemon/planner.js';
import { diagnosticianSettings } from '../../src/runner/payloads.js';
import type { RunOptions, RunResult, Runner } from '../../src/runner/types.js';
import { PROOF, api, coordinatorRoot, engine, principals } from './soak-plane.js';
import { clock } from './soak-world.js';

/**
 * GY-1418: the planner role's day, beside the acceptance role's (acceptanceWorld in
 * tests/helpers/soak-simulation.ts). Each goal whose acceptance pull request merged is planned by a
 * faked headless run, judged by a faked approver run, released on the soak plane's real
 * /api/goals/:key/release, and its items are worked by the day's simulated workers like any other.
 * `signup`'s first plan lets two parallel items share a file, so it is refused before approval and
 * planned again after an hour; its first release dies after the control plane created its first
 * item, so the retry must find that item instead of making it twice; and its first delivery is
 * refused by a bad gateway. `billing`'s first plan is refused by the approver. `audit` plans,
 * is approved and released at the first try, into two parallel items. `rewrite`, recorded here with
 * its acceptance already merged, is planned with a wildcard file boundary its parallel items share
 * every time, so its plan rounds run out before any approver sees one and it is left to the master.
 */
export async function plannerWorld(dayStart: number, accepted: Record<string, string>) {
  const recorded = (await api(principals.operatorAgent, 'POST', 'goals', { statement: 'Customers can use rewrite without help', users: ['Repository operators'], constraints: [], deployTarget: 'uat' })) as Goal;
  const at = new Date(clock.now()).toISOString(), outcome = `rewrite-${recorded.revision}`;
  let rewrite = applyGoalCommand(recorded, 'draft', { outcomes: [{ id: outcome, title: 'A customer completes rewrite', criteria: ['The rewrite page answers'], case: { id: outcome, title: 'rewrite answers', tags: ['api'], target: 'uat', required: true,
    steps: [{ kind: 'http', name: 'read the board', method: 'GET', path: '/api/board', status: 200 }] } }], pr: 4999, branch: 'graphyard/rewrite-acceptance', head: 'e'.repeat(40) }, { actor: principals.operatorAgent, at });
  rewrite = applyGoalCommand(rewrite, 'approve', { reason: 'What a customer asked for' }, { actor: principals.approver, at });
  rewrite = applyGoalCommand(rewrite, 'merged', { pr: 4999, mergeSha: 'f'.repeat(40) }, { actor: principals.coordinator, at });
  await appendGoal(engine.store.pool, principals.coordinator.id, 'merged', rewrite, { pr: 4999 });
  const goals: Record<string, string> = { ...accepted, rewrite: rewrite.key };
  const day = {
    goals,
    runs: [] as { goal: string; role: 'plan' | 'judge'; revision: number; at: number }[],
    releases: [] as { goal: string; ok: boolean; at: number }[],
    delivers: [] as { goal: string; ok: boolean; at: number }[],
  };
  const named = (key: string) => Object.entries(goals).find(([, goal]) => goal === key)![0];
  const criteria = (text: string) => [{ id: 'AC-1', text, proofs: [PROOF] }];
  const planItem = (goal: Goal, ref: string, plannedFiles: string[], dependsOn: string[] = []) => {
    const outcome = goal.acceptance!.outcomes[0];
    return { ref, title: `${named(goal.key)}: build the ${ref}`, description: `The ${ref} of ${goal.key}`, type: 'feature' as const, priority: 2,
      outcomes: [outcome.id], cases: [outcome.case.id], criteria: criteria(`The ${ref} serves ${outcome.title}`), plannedFiles, dependsOn };
  };
  const note = (goal: Goal) => `A small ${named(goal.key)} module under src/goal/${named(goal.key)}/, served by the existing API and deployed with the service.`;
  const planOf = (goal: Goal): GoalPlan => {
    const name = named(goal.key), runs = day.runs.filter(run => run.goal === name && run.role === 'plan').length;
    const base = `src/goal/${name}`;
    if (name === 'signup' && runs === 1) return { note: note(goal), items: [planItem(goal, 'api', [`${base}/api.ts`, `${base}/shared.ts`]), planItem(goal, 'ui', [`${base}/ui.ts`, `${base}/shared.ts`])] };
    if (name === 'signup') return { note: note(goal), items: [planItem(goal, 'api', [`${base}/api.ts`, `${base}/shared.ts`]), planItem(goal, 'ui', [`${base}/ui.ts`, `${base}/shared.ts`], ['api'])] };
    if (name === 'rewrite') return { note: note(goal), items: [planItem(goal, 'model', [`${base}/**`]), planItem(goal, 'view', [`${base}/view.ts`])] };
    if (name === 'audit') return { note: note(goal), items: [planItem(goal, 'log', [`${base}/log.ts`]), planItem(goal, 'report', [`${base}/report.ts`])] };
    return { note: note(goal), items: [planItem(goal, 'invoice', [`${base}/invoice.ts`])] };
  };
  const runner = (role: 'plan' | 'judge', goal: Goal): Runner => ({ name: 'soak-planner', start<T>(_prompt: string, options: RunOptions<T>) {
    const name = named(goal.key);
    day.runs.push({ goal: name, role, revision: goal.revision, at: clock.now() - dayStart });
    const refuse = role === 'judge' && name === 'billing' && (goal.planDrafts ?? 0) === 1;
    const payload = role === 'plan' ? { goal: goal.key, ...planOf(goal) }
      : { goal: goal.key, verdict: refuse ? 'refuse' : 'approve', reason: refuse ? 'One invoice item is too large for one worker' : 'Each item is one worker\'s change and the order keeps parallel items apart' };
    const result: RunResult<T> = { ok: true, tool: options.tool, payload: options.validate(payload), payloads: [] };
    return { id: `soak-planner-${day.runs.length}`, events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
  } });
  const effects: PlannerEffects = {
    settings: diagnosticianSettings({}), cwd: coordinatorRoot!,
    goals: async () => (await api(principals.coordinator, 'GET', 'goals?open=1')).goals,
    runner: async (role, attempt, goal) => ({ runner: runner(role, goal), runtime: `soak-${attempt}`, model: attempt }),
    plan: (goal, plan) => api(principals.operatorAgent, 'POST', `goals/${goal.key}/plan`, plan, `planner:${goal.id}:${goal.revision}`),
    invalid: (goal, reason) => api(principals.operatorAgent, 'POST', `goals/${goal.key}/plan-invalid`, { reason }, `planner:${goal.id}:${goal.revision}:invalid`),
    judge: (goal, judgement) => api(principals.approver, 'POST', `goals/${goal.key}/plan-${judgement.verdict}`, { reason: judgement.reason }, `planner:${goal.id}:${goal.revision}:judged`),
    release: async goal => {
      const name = named(goal.key), first = !day.releases.some(entry => entry.goal === name);
      day.releases.push({ goal: name, ok: !(name === 'signup' && first), at: clock.now() - dayStart });
      if (name === 'signup' && first) {
        // The control plane created the first item of the order under releasePlan's own key, then died before answering.
        const plan = goal.plan!, item = planOrder(plan)[0];
        await engine.execute(principals.operatorAgent, 'create', null, planItemInput({ ...goal, plan, planApproval: goal.planApproval! }, item, new Map()), `goal-plan:${goal.id}:${plan.draftedAt}:${item.ref}:create`);
        throw new Error('Graphyard refused goals (502): Bad Gateway');
      }
      return api(principals.operatorAgent, 'POST', `goals/${goal.key}/release`, {}, `planner:${goal.id}:${goal.revision}:release`);
    },
    deliver: async (goal, items, reason) => {
      const name = named(goal.key), first = !day.delivers.some(entry => entry.goal === name);
      day.delivers.push({ goal: name, ok: !(name === 'signup' && first), at: clock.now() - dayStart });
      if (name === 'signup' && first) throw new Error('Graphyard refused goals (502): Bad Gateway');
      return api(principals.operatorAgent, 'POST', `goals/${goal.key}/deliver`, { items, reason }, `planner:${goal.id}:${goal.revision}:deliver`);
    },
  };
  return { day, effects };
}

/** The work items each goal's released plan made, read from the plane: every item whose title the plan's items carry. */
export async function plannedWork(goals: Record<string, string>) {
  const all = await api(principals.coordinator, 'GET', 'work') as Work[];
  return Object.fromEntries(Object.entries(goals).map(([name, key]) => [name, all.filter(entry => entry.title.startsWith(`${key}: ${name}: build the `))]));
}
