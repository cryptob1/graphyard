import { createHash } from 'node:crypto';
import type pg from 'pg';
import { demand, operatorCapability, type OperatorCapability, type Principal, type Work } from '../../model.js';
import { appendGoal, applyGoalCommand, goalCommandSchemas, goalHistory, goalKeyPattern, goalSummary, implementersOf, readGoals, recordGoal, type Goal, type GoalCommand, type GoalContext, type Landing } from '../../model/goal.js';
import { planItemInput, planItemMark, planOrder, mergedItem } from '../../model/goal-plan.js';
import type { Engine } from '../../engine.js';
import type { Store } from '../../store.js';
import { gitRunnerFor, type GitResult, type GitRunner } from '../../merge-writer/local-observation.js';
import { Refusal } from '../../model/refusal.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';

/**
 * Goals (GY-1417): `graphyard goal FILE` records one, the acceptance role drafts its outcomes and
 * cases, an independent approver judges the draft, the loop lands its pull request (or records it
 * closed unmerged, which returns the goal to drafting), the planner (GY-1418) plans it, an approver
 * other than the plan's author judges the plan, the loop releases its items, and
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
/**
 * Who may run each command on an existing goal. A case change is asked by whoever works on the item.
 * `merged` is no route: only the land route records it, from what GitHub reports.
 */
const permitted: Record<Exclude<GoalCommand, 'record' | 'merged' | 'released'>, (context: RouteContext) => void> = {
  draft: intent, approve: judge, refuse: judge, closed: intent, deliver: intent, land: intent, 'case-change-approve': judge, 'case-change-refuse': judge,
  plan: intent, 'plan-approve': judge, 'plan-refuse': judge, 'plan-invalid': intent, release: intent, amend: intent,
  'case-change': context => demand(!['reader', 'producer'].includes(context.actor.role), 'A reader or producer cannot request a case change', 403),
};
const find = (goals: Goal[], ref: string) => goals.find(goal => goal.key === ref || goal.id === ref);
/** GY-2602: the human-only request with this id and the item it was raised on, answered or still open. */
async function humanRequestById(db: pg.PoolClient, id: string): Promise<GoalContext['decision']> {
  const row = (await db.query(`SELECT i.key, w.document FROM work_items w JOIN work_index i ON i.id = w.id
    WHERE w.document->'humanRequests' @> $1::jsonb OR w.document->'humanRequest'->>'id' = $2 LIMIT 1`, [JSON.stringify([{ id }]), id])).rows[0];
  const work = row?.document as Work | undefined;
  const request = [...(work?.humanRequests ?? []), ...(work?.humanRequest ? [work.humanRequest] : [])].find(entry => entry.id === id);
  return request ? { work: row.key, request } : null;
}
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

/**
 * GY-1535: why the base does not hold a merge-writer landing of `head` as `mergeSha`, or null when it
 * does: the commit is on the first-parent history of `refs/remotes/origin/BASE` in the checkout the
 * control plane shares with the merge writer, and its second parent is exactly the approved head.
 */
export async function acceptanceMergeRefusal(git: GitRunner, base: string, head: string, mergeSha: string): Promise<string | null> {
  const ref = `refs/remotes/origin/${base}`;
  const second = await git(['rev-parse', '--verify', '--quiet', `${mergeSha}^2`]);
  if (second.status !== 0 || second.stdout.trim().toLowerCase() !== head) return `${mergeSha.slice(0, 12)} is not a merge of the approved head ${head.slice(0, 12)}`;
  const listed = await git(['rev-list', '--first-parent', ref]);
  if (listed.status !== 0) return `the control plane's checkout holds no ${ref}: ${listed.stderr.trim()}`;
  return listed.stdout.split('\n').some(line => line.trim().toLowerCase() === mergeSha) ? null : `${base}'s first-parent history does not hold ${mergeSha.slice(0, 12)}`;
}

/**
 * GY-1661/GY-1922: the land route's judgement of a merge-writer landing. BASE is fetched first, so a merge
 * the writer pushed (or a rewrite of BASE) since the checkout's last fetch is judged. Only a failed fetch
 * falls back to the checkout's own origin/BASE, which the loop fetches (a compose container has no SSH
 * credential): holding that merge of the approved head, it lands; else a retryable 503 records nothing.
 * Everything is bounded by `timeoutMs`, so a stall answers inside the caller's own timeout.
 */
export async function acceptanceLandingRefusal(git: GitRunner, base: string, head: string, mergeSha: string, timeoutMs = acceptanceFetchTimeoutMs): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>(resolve => { timer = setTimeout(() => resolve('expired'), timeoutMs); timer.unref(); });
  try {
    const fetching = git(['fetch', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { timeoutMs });
    const fetched = await Promise.race([fetching.catch((error: unknown): GitResult => ({ status: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) })), expired]);
    if (fetched !== 'expired' && fetched.status === 0) return acceptanceMergeRefusal(git, base, head, mergeSha);
    const held = fetched === 'expired' ? 'expired' : await Promise.race([acceptanceMergeRefusal(git, base, head, mergeSha).catch(() => 'unread'), expired]);
    if (held === null) return null;
    const failure = fetched === 'expired' ? `git fetch did not finish within ${timeoutMs}ms` : held === 'expired' ? `${fetched.stderr.trim().slice(0, 400) || `git exited ${fetched.status}`}; reading refs/remotes/origin/${base} did not finish within ${timeoutMs}ms` : fetched.stderr.trim().slice(0, 500) || `git exited ${fetched.status}`;
    throw new Refusal(`The control plane could not fetch ${base} from origin to read the merge writer's landing (${failure}); nothing is recorded until it can`, 503);
  } finally { clearTimeout(timer); }
}
/** How long the land route waits on its base fetch (GY-1661): well inside the loop's 30-second request timeout. */
export const acceptanceFetchTimeoutMs = 20_000;

/** What landing found, recorded under the lock unless the goal moved on meanwhile: merged at its approved head, else closed and drafted again. */
export async function recordLanding(store: Pick<Store, 'transaction'>, goal: Goal, landing: Landing, actor: Principal): Promise<Goal> {
  const { pr, head } = goal.acceptance!;
  return store.transaction(async (db, now) => {
    const current = find(await readGoals(db), goal.id);
    demand(current, 'Goal not found', 404);
    if (current.stage !== 'accepted' || current.acceptance?.pr !== pr || current.acceptance.head !== head) return current;
    const [command, input] = landing.state === 'merged' ? ['merged', { pr, mergeSha: landing.mergeSha }] as const : ['closed', { pr, reason: landing.detail }] as const;
    const changed = applyGoalCommand(current, command, input, { actor, at: now.toISOString() });
    await appendGoal(db, actor.id, command, changed, input);
    return changed;
  });
}

/**
 * Creates and releases an approved plan's items in dependency order, as the calling operator agent
 * (GY-1418): each is created with the ids of the items it depends on, so the dispatcher's ready gate
 * holds it until they are done. A retry after a partial release finds the items already made by the
 * mark their description opens with (planItemMark), which outlives the per-item idempotency keys'
 * receipts, instead of making them twice. Then, under the
 * lock, the goal is recorded released only when every item exists, is released and carries exactly
 * its planned dependencies.
 */
export async function releasePlan(engine: Pick<Engine, 'execute' | 'store'>, actor: Principal, goal: Goal): Promise<Goal> {
  demand(goal.stage === 'planned' && goal.plan && goal.planApproval, `${goal.key} is ${goal.stage}; only an approved plan is released`);
  const plan = goal.plan, approval = goal.planApproval;
  const created = new Map<string, Work>();
  for (const item of planOrder(plan)) {
    const key = `goal-plan:${goal.id}:${plan.draftedAt}:${item.ref}`;
    const input = planItemInput({ ...goal, plan, planApproval: approval }, item, created), mark = planItemMark(goal, plan, item);
    let work = (await engine.store.pool.query('SELECT document FROM work_items WHERE document->>\'title\' = $1 AND left(document->>\'description\', $2) = $3 ORDER BY number LIMIT 1', [input.title, mark.length, mark])).rows[0]?.document as Work | undefined
      ?? await engine.execute(actor, 'create', null, input, `${key}:create`) as Work;
    if (!work.ready) work = await engine.execute(actor, 'ready', work.id, { expectedRevision: work.revision, reason: `${goal.key}'s plan was approved by ${approval.by}` }, `${key}:ready`) as Work;
    created.set(item.ref, work);
  }
  return engine.store.transaction(async (db, now) => {
    const current = find(await readGoals(db), goal.id);
    demand(current, 'Goal not found', 404);
    if (current.stage !== 'planned' || current.plan?.draftedAt !== plan.draftedAt) return current;
    const unreleased: string[] = [];
    for (const item of plan.items) {
      const work = await workByKey(db, created.get(item.ref)!.key);
      const wanted = item.dependsOn.map(ref => created.get(ref)!.id).sort();
      if (!work) unreleased.push(`${item.ref} has no work item`);
      else if (!work.ready) unreleased.push(`${work.key} (${item.ref}) is not released`);
      else if (JSON.stringify([...work.dependencies].sort()) !== JSON.stringify(wanted)) unreleased.push(`${work.key} (${item.ref}) does not carry its planned dependencies`);
    }
    const input = { items: plan.items.map(item => ({ ref: item.ref, key: created.get(item.ref)!.key, id: created.get(item.ref)!.id })) };
    const changed = applyGoalCommand(current, 'released', input, { actor, at: now.toISOString(), unreleased });
    await appendGoal(db, actor.id, 'released', changed, input);
    return changed;
  });
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
    // GY-1535: an approved acceptance change is landed by the loop's merge writer, which names the merge commit it pushed; it is recorded merged only once the base holds that merge of the approved head.
    method: 'POST', path: /^\/api\/goals\/([^/]+)\/land$/,
    async handle(context, [ref]) {
      intent(context);
      const body = goalCommandSchemas.land.parse(await parseJson(context, 1024, '{}'));
      const { engine } = context.services;
      const goal = find(await readGoals(engine.store.pool), decodeURIComponent(ref));
      demand(goal, 'Goal not found', 404);
      if (goal.merged && goal.stage !== 'accepted') return { goal, landing: { state: 'merged', mergeSha: goal.merged.mergeSha, detail: goal.merged.pr === null ? `merged as ${goal.merged.mergeSha}` : `#${goal.merged.pr} merged` } };
      demand(goal.stage === 'accepted' && goal.acceptance && goal.approval, `${goal.key} is ${goal.stage}; only an approved acceptance draft is landed`);
      if (goal.acceptance.pr === null) {
        demand(body.mergeSha, `${goal.key}'s acceptance change has no pull request: the merge writer lands it and names the merge commit it pushed`, 422);
        demand(goal.approval.by !== goal.acceptance.author && goal.approval.head === goal.acceptance.head, `${goal.key}'s acceptance change is sensitive and lands only on an approver's verdict on its exact head by another identity`, 403);
        if (engine.gitRunner === undefined) engine.gitRunner = gitRunnerFor(process.env.GRAPHYARD_REPOSITORY_ROOT ?? process.cwd());
        demand(engine.gitRunner, 'The control plane has no checkout to read the merge writer\'s landing from', 503);
        const refusal = await acceptanceLandingRefusal(engine.gitRunner, engine.baseBranch, goal.approval.head, body.mergeSha);
        demand(!refusal, `${goal.key}'s acceptance change is not landed: ${refusal}`, 422);
        const landing: Landing = { state: 'merged', mergeSha: body.mergeSha, detail: `the merge writer merged ${goal.key}'s acceptance change as ${body.mergeSha}` };
        return { goal: await recordLanding(engine.store, goal, landing, context.actor), landing };
      }
      // An acceptance pull request is no longer landed: the control plane is the only merge writer and a change reaches the base through the merge writer's landing alone.
      demand(false, `${goal.key}'s acceptance is pull request #${goal.acceptance.pr}; Graphyard no longer lands pull requests, so the merge writer lands the acceptance change and names its merge commit`, 422);
    },
  },
  {
    // The loop releases an approved plan (GY-1418): its items are created and released in dependency order, then the goal is delivering.
    method: 'POST', path: /^\/api\/goals\/([^/]+)\/release$/,
    async handle(context, [ref]) {
      intent(context);
      goalCommandSchemas.release.parse(await parseJson(context, 1024, '{}'));
      const { engine } = context.services;
      const goal = find(await readGoals(engine.store.pool), decodeURIComponent(ref));
      demand(goal, 'Goal not found', 404);
      if (goal.stage !== 'planned' && goal.items?.length) return goal;
      return releasePlan(engine, context.actor, goal);
    },
  },
  {
    method: 'POST', path: /^\/api\/goals\/([^/]+)\/(draft|approve|refuse|closed|deliver|plan|plan-approve|plan-refuse|plan-invalid|case-change|case-change-approve|case-change-refuse|amend)$/,
    async handle(context, [ref, verb]) {
      const command = verb as Exclude<GoalCommand, 'record' | 'land' | 'merged' | 'release' | 'released'>;
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
        let implementers: string[] = [], undelivered: string[] | undefined;
        // Delivery waits on every named item being merged, never a bare assertion.
        if (command === 'deliver') { undelivered = []; for (const key of goalCommandSchemas.deliver.parse(input).items) if (!mergedItem(await workByKey(db, key))) undelivered.push(key); }
        if (command === 'case-change') demand(await workByKey(db, goalCommandSchemas[command].parse(input).work), `${input.work} is no work item; a case change names the existing item that needs it`, 404);
        if (command === 'case-change-approve' || command === 'case-change-refuse') {
          const change = goal.caseChanges.find(entry => entry.id === goalCommandSchemas[command].parse(input).change);
          if (change) {
            const work = await workByKey(db, change.work);
            demand(work, `${change.work} is no work item; a case change is judged only for an existing item, against its implementers`, 422);
            implementers = implementersOf(work);
          }
        }
        const decision = command === 'amend' ? await humanRequestById(db, goalCommandSchemas.amend.parse(input).decision) : undefined;
        const next = applyGoalCommand(goal, command, input, { actor, at: now.toISOString(), others: goals, implementers, undelivered, decision });
        await appendGoal(db, actor.id, command, next, input);
        return next;
      });
    },
  },
]);
