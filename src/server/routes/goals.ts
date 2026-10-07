import { demand, operatorCapability, type OperatorCapability, type Principal } from '../../model.js';
import { appendGoal, applyGoalCommand, goalHistory, goalKeyPattern, goalSummary, readGoals, recordGoal, type Goal, type GoalCommand } from '../../model/goal.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';

/**
 * Goals (GY-1417): `graphyard goal FILE` records one, the acceptance role drafts its outcomes and
 * cases, an independent approver judges the draft, the master records its pull request merged, and
 * case changes after that are judged by an approver who is neither their requester nor an
 * implementer of their item. This module authorizes its callers itself, so it is matched ahead of
 * the operator-agent route guard: an operator agent records intent with `intent:create` and judges
 * with `decision:approve`, each within its repository scope.
 */
const intent = (context: RouteContext) => allow(context, ['admin', 'coordinator'], 'intent:create');
const judge = (context: RouteContext) => allow(context, ['admin'], 'decision:approve');
function allow({ actor, services }: RouteContext, roles: Principal['role'][], capability: OperatorCapability) {
  if (actor.role === 'operator-agent') return operatorCapability(actor, capability, undefined, services.repository);
  demand(roles.includes(actor.role), `${actor.id} is a ${actor.role}; this goal command needs ${roles.join(' or ')} or an operator agent holding ${capability}`, 403);
}
/** Who may run each command on an existing goal. A case change is asked by whoever works on the item. */
const permitted: Record<Exclude<GoalCommand, 'record'>, (context: RouteContext) => void> = {
  draft: intent, approve: judge, refuse: judge, merged: intent, deliver: intent, 'case-change-approve': judge, 'case-change-refuse': judge,
  'case-change': context => demand(!['reader', 'producer'].includes(context.actor.role), 'A reader or producer cannot request a case change', 403),
};
const find = (goals: Goal[], ref: string) => goals.find(goal => goal.key === ref || goal.id === ref);

export const goalRoutes = defineRoutes('goals', [
  {
    method: 'GET', path: '/api/goals',
    async handle({ services, url }) {
      const goals = await readGoals(services.engine.store.pool);
      const open = url.searchParams.get('open') === '1';
      return { goals: (open ? goals.filter(goal => goal.stage !== 'delivered') : goals).map(goal => url.searchParams.get('view') === 'summary' ? goalSummary(goal) : goal) };
    },
  },
  {
    method: 'GET', path: /^\/api\/goals\/([^/]+)$/,
    async handle({ services }, [ref]) {
      const goal = find(await readGoals(services.engine.store.pool), decodeURIComponent(ref));
      demand(goal, 'Goal not found', 404);
      return { goal, history: await goalHistory(services.engine.store.pool, goal.id) };
    },
  },
  {
    method: 'POST', path: '/api/goals',
    async handle(context) {
      intent(context);
      const input = await parseJson(context, 65_536);
      return context.services.engine.store.transaction(async (db, now) => {
        const recorded = Number((await db.query("SELECT count(*) AS n FROM events WHERE work_id IS NULL AND kind='goal.recorded'")).rows[0].n);
        const goal = recordGoal(input, `GOAL-${recorded + 1}`, { actor: context.actor, at: now.toISOString() });
        demand(goalKeyPattern.test(goal.key), 'Goal key overflow', 500);
        await appendGoal(db, context.actor.id, 'record', goal, input);
        return goal;
      });
    },
  },
  {
    method: 'POST', path: /^\/api\/goals\/([^/]+)\/(draft|approve|refuse|merged|deliver|case-change|case-change-approve|case-change-refuse)$/,
    async handle(context, [ref, verb]) {
      const command = verb as Exclude<GoalCommand, 'record'>;
      permitted[command](context);
      const input = await parseJson(context, 262_144);
      const { engine } = context.services;
      return engine.store.transaction(async (db, now) => {
        // A persisted operator agent is read again under the lock it commits under, so one revoked since it authenticated changes nothing.
        let actor = context.actor;
        if (actor.role === 'operator-agent' && engine.operatorAuthorizer) { actor = await engine.operatorAuthorizer(db, now, actor); permitted[command]({ ...context, actor }); }
        const goals = await readGoals(db);
        const goal = find(goals, decodeURIComponent(ref));
        demand(goal, 'Goal not found', 404);
        // A case change is judged against everyone who has implemented the item it is for.
        let implementers: string[] = [];
        if (command === 'case-change-approve' || command === 'case-change-refuse') {
          const change = goal.caseChanges.find(entry => entry.id === input?.change);
          if (change) {
            const row = (await db.query('SELECT w.document FROM work_index i JOIN work_items w ON w.id = i.id WHERE i.key = $1', [change.work])).rows[0];
            const work = row?.document as { implementers?: string[]; lease?: { owner: string } | null; lastAssignment?: { owner: string } | null } | undefined;
            implementers = [...(work?.implementers ?? []), ...(work?.lease ? [work.lease.owner] : []), ...(work?.lastAssignment ? [work.lastAssignment.owner] : [])];
          }
        }
        const next = applyGoalCommand(goal, command, input, { actor, at: now.toISOString(), others: goals, implementers });
        await appendGoal(db, actor.id, command, next, input);
        return next;
      });
    },
  },
]);
