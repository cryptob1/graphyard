import { createHash } from 'node:crypto';
import type pg from 'pg';
import { CHECK_NAME, demand, operatorCapability, type OperatorCapability, type Principal, type Work } from '../../model.js';
import { appendGoal, applyGoalCommand, goalCommandSchemas, goalHistory, goalKeyPattern, goalSummary, implementersOf, readGoals, recordGoal, type Goal, type GoalCommand, type Landing } from '../../model/goal.js';
import { landableCarried } from '../../landable-check.js';
import type { GitHub } from '../../github.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';

/**
 * Goals (GY-1417): `graphyard goal FILE` records one, the acceptance role drafts its outcomes and
 * cases, an independent approver judges the draft, the loop lands its pull request (or records it
 * closed unmerged, which returns the goal to drafting), and
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
  draft: intent, approve: judge, refuse: judge, merged: intent, closed: intent, deliver: intent, land: intent, 'case-change-approve': judge, 'case-change-refuse': judge,
  'case-change': context => demand(!['reader', 'producer'].includes(context.actor.role), 'A reader or producer cannot request a case change', 403),
};
const find = (goals: Goal[], ref: string) => goals.find(goal => goal.key === ref || goal.id === ref);
const workByKey = async (db: pg.PoolClient, key: string) => (await db.query('SELECT w.document FROM work_index i JOIN work_items w ON w.id = i.id WHERE i.key = $1', [key])).rows[0]?.document as Work | undefined;

/**
 * Every recording command runs once per Idempotency-Key, as the other mutating routes do: a retry of
 * one whose response was lost answers the first result instead of recording a second goal or case
 * change, and a key reused with other input is refused.
 */
async function once<T>(context: RouteContext, input: unknown, run: (db: pg.PoolClient, now: Date) => Promise<T>): Promise<T> {
  const key = context.idempotencyKey();
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify([context.url.pathname, input])).digest('hex');
  return context.services.engine.store.transaction(async (db, now) => {
    const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [context.actor.id, key])).rows[0];
    if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result as T; }
    const result = await run(db, now);
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [context.actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}

export type LandingGitHub = Pick<GitHub, 'config' | 'request' | 'pages' | 'graphql' | 'upsertLandable'>;
const mergeMutation = 'mutation($id: ID!, $head: GitObjectID!, $method: PullRequestMergeMethod!) { mergePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head, mergeMethod: $method }) { pullRequest { id } } }';
const mergeMethod = () => (['MERGE', 'SQUASH', 'REBASE'] as const).find(method => method === process.env.GITHUB_MERGE_METHOD?.toUpperCase()) ?? 'MERGE';

/**
 * Lands an approved acceptance pull request (GY-1417). It is no work item, so nothing else publishes
 * the App-bound `Graphyard / merge` and `graphyard/landable` verdicts a managed base branch requires:
 * here the control-plane App publishes both on exactly the approved head — the approval by an identity
 * other than its author is its gate — and merges head-bound, as the main guard lands a revert. GitHub
 * still enforces CI and its review rules, so a merge it refuses is `waiting`. A pull request whose
 * head moved off the approved one, or that conflicts with its base, is never landed.
 */
export async function landAcceptance(github: LandingGitHub, goal: Goal): Promise<Landing> {
  const { pr } = goal.acceptance!, { head, by, reason } = goal.approval!;
  const pull = await github.request(`/pulls/${pr}`);
  if (pull?.merged) return { state: 'merged', mergeSha: pull.merge_commit_sha ?? null, detail: `#${pr} merged` };
  if (pull?.state !== 'open') return { state: 'closed', mergeSha: null, detail: `acceptance pull request #${pr} was closed without merging` };
  if (pull.head?.sha !== head || pull.base?.ref !== github.config.base) return { state: 'moved', mergeSha: null, detail: `acceptance pull request #${pr} is at ${String(pull.head?.sha).slice(0, 12)} on ${pull.base?.ref}, not its approved head ${head.slice(0, 12)} on ${github.config.base}` };
  if (pull.mergeable === false || pull.mergeable_state === 'dirty') return { state: 'conflicting', mergeSha: null, detail: `acceptance pull request #${pr} conflicts with ${github.config.base}` };
  const summary = `Acceptance of ${goal.key} at ${head}: approved by ${by}, not its author ${goal.acceptance!.author}: ${reason}`.slice(0, 4000);
  const existing = (await github.pages(`/commits/${head}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`, 'check_runs')).find(run => run.app?.id === github.config.appId);
  const body = { name: CHECK_NAME, head_sha: head, status: 'completed', conclusion: 'success', external_id: goal.id, output: { title: 'Acceptance approved', summary } };
  if (!(existing?.status === body.status && existing.conclusion === body.conclusion && existing.external_id === body.external_id && existing.output?.title === body.output.title && existing.output?.summary === body.output.summary))
    await github.request(existing ? `/check-runs/${existing.id}` : '/check-runs', existing ? 'PATCH' : 'POST', body);
  await github.upsertLandable(landableCarried(goal, head, 'Landable', summary));
  try { await github.graphql(mergeMutation, { id: pull.node_id, head, method: mergeMethod() }); }
  catch (error) { return { state: 'waiting', mergeSha: null, detail: `GitHub has not merged #${pr} yet: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000) }; }
  const merged = await github.request(`/pulls/${pr}`);
  return merged?.merged ? { state: 'merged', mergeSha: merged.merge_commit_sha ?? null, detail: `#${pr} merged` } : { state: 'waiting', mergeSha: null, detail: `GitHub accepted the merge of #${pr} but has not reported it merged yet` };
}

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
      return once(context, input, async (db, now) => {
        const recorded = Number((await db.query("SELECT count(*) AS n FROM events WHERE work_id IS NULL AND kind='goal.recorded'")).rows[0].n);
        const goal = recordGoal(input, `GOAL-${recorded + 1}`, { actor: context.actor, at: now.toISOString() });
        demand(goalKeyPattern.test(goal.key), 'Goal key overflow', 500);
        await appendGoal(db, context.actor.id, 'record', goal, input);
        return goal;
      });
    },
  },
  {
    // The loop lands an approved acceptance pull request: merged, it is recorded merged; closed, moved or conflicting, it is closed and recorded closed, so the goal is drafted again.
    method: 'POST', path: /^\/api\/goals\/([^/]+)\/land$/,
    async handle(context, [ref]) {
      intent(context);
      goalCommandSchemas.land.parse(await parseJson(context, 1024, '{}'));
      const { engine, github } = context.services;
      const goal = find(await readGoals(engine.store.pool), decodeURIComponent(ref));
      demand(goal, 'Goal not found', 404);
      if (goal.merged && goal.stage !== 'planned') return { goal, landing: { state: 'merged', mergeSha: goal.merged.mergeSha, detail: `#${goal.merged.pr} merged` } };
      demand(goal.stage === 'planned' && goal.acceptance && goal.approval, `${goal.key} is ${goal.stage}; only an approved acceptance draft is landed`);
      demand(github, 'No GitHub App is configured on this control plane, so no acceptance pull request can be landed', 503);
      const landing = await landAcceptance(github, goal);
      if (landing.state === 'waiting') return { goal, landing };
      const { pr, branch } = goal.acceptance;
      if (landing.state !== 'merged' && landing.state !== 'closed') {
        await github.request(`/issues/${pr}/comments`, 'POST', { body: `Closed by Graphyard: ${landing.detail}. ${goal.key}'s outcomes are opened again on a new pull request from the current base and judged again.` });
        await github.request(`/pulls/${pr}`, 'PATCH', { state: 'closed' });
        if (branch.startsWith('graphyard/')) await github.request(`/git/refs/heads/${branch}`, 'DELETE').catch(() => undefined);
      }
      const next = await engine.store.transaction(async (db, now) => {
        const current = find(await readGoals(db), goal.id);
        demand(current, 'Goal not found', 404);
        if (current.stage !== 'planned' || current.acceptance?.pr !== pr) return current;
        const [command, input] = landing.state === 'merged' ? ['merged', { pr, mergeSha: landing.mergeSha }] as const : ['closed', { pr, reason: landing.detail }] as const;
        const changed = applyGoalCommand(current, command, input, { actor: context.actor, at: now.toISOString() });
        await appendGoal(db, context.actor.id, command, changed, input);
        return changed;
      });
      return { goal: next, landing };
    },
  },
  {
    method: 'POST', path: /^\/api\/goals\/([^/]+)\/(draft|approve|refuse|merged|closed|deliver|case-change|case-change-approve|case-change-refuse)$/,
    async handle(context, [ref, verb]) {
      const command = verb as Exclude<GoalCommand, 'record' | 'land'>;
      permitted[command](context);
      const input = await parseJson(context, 262_144);
      const { engine } = context.services;
      return once(context, input, async (db, now) => {
        // A persisted operator agent is read again under the lock it commits under, so one revoked since it authenticated changes nothing.
        let actor = context.actor;
        if (actor.role === 'operator-agent' && engine.operatorAuthorizer) { actor = await engine.operatorAuthorizer(db, now, actor); permitted[command]({ ...context, actor }); }
        const goals = await readGoals(db);
        const goal = find(goals, decodeURIComponent(ref));
        demand(goal, 'Goal not found', 404);
        // A case change names an item that exists, and is judged against everyone who has implemented it:
        // a grant for an item not yet created could be approved by whoever later implements it.
        let implementers: string[] = [];
        if (command === 'case-change') demand(await workByKey(db, goalCommandSchemas[command].parse(input).work), `${input.work} is no work item; a case change names the existing item that needs it`, 404);
        if (command === 'case-change-approve' || command === 'case-change-refuse') {
          const change = goal.caseChanges.find(entry => entry.id === goalCommandSchemas[command].parse(input).change);
          if (change) {
            const work = await workByKey(db, change.work);
            demand(work, `${change.work} is no work item; a case change is judged only for an existing item, against its implementers`, 422);
            implementers = implementersOf(work);
          }
        }
        const next = applyGoalCommand(goal, command, input, { actor, at: now.toISOString(), others: goals, implementers });
        await appendGoal(db, actor.id, command, next, input);
        return next;
      });
    },
  },
]);
