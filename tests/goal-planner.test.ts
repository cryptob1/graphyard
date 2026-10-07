import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { appendGoal, applyGoalCommand, goalSummary, protectedCaseRefusals, recordGoal, type Goal } from '../src/model/goal.js';
import type { GoalPlan } from '../src/model/goal-plan.js';
import { registryRoles, roleSchema } from '../src/model/registry.js';
import { proposedConcurrency } from '../src/model/registry-proposal.js';
import type { PlannerEffects } from '../src/daemon/planner.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import * as pi from '../integrations/pi/index.js';

/** The planner's modules, loaded inside each test so a tree without them fails as a test case, not as a file that cannot load. */
const planner = async () => ({ ...await import('../src/model/goal-plan.js'), ...await import('../src/daemon/planner.js'), ...await import('../src/model/goal.js') });

// GY-1418: a goal whose acceptance merged becomes a short architecture note and a dependency-ordered
// set of work items with file boundaries, written by the planner, approved by an identity that did
// not write it, and only then created and released, so the dispatcher delivers them in order.
const repository = 'owner/planner';
const master: Principal = { id: 'plan-master', role: 'coordinator', sessionKind: 'ai' };
const planAuthor: Principal = { id: 'plan-author', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'plan-approver', role: 'admin', sessionKind: 'ai' };
const credentials = [master, planAuthor, approver].map(principal => ({ ...principal, token: `plan-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
});
before(async () => {
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('planner'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('planner_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/planner_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { await planner().then(loaded => loaded.clearPlans(), () => {}); if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const call = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as any };
};
const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const answer = await call(principal, method, path, body);
  assert.equal(answer.status, 200, answer.text);
  return answer.body;
};

const caseOf = (id: string) => ({ id, title: `The ${id} outcome is reachable`, description: 'A customer reads the page.', tags: ['api'], target: 'uat', required: true,
  steps: [{ kind: 'http', name: 'read the page', method: 'GET', path: '/api/board', status: 200, expect: [{ path: 'groups.backlog', type: 'array' }] }] });
const outcome = (id: string) => ({ id, title: `A customer can ${id}`, criteria: [`The ${id} page answers`], case: caseOf(`${id}-case`) });
/** A goal whose acceptance pull request merged, built through the goal commands themselves: drafted, approved by another identity, merged. */
function mergedGoal(key: string, outcomes = ['signup', 'billing']): Goal {
  const at = new Date().toISOString();
  let goal = recordGoal({ statement: `Customers can ${outcomes.join(' and ')}`, users: ['Customers'], constraints: [], deployTarget: 'uat then production' }, key, { actor: master, at });
  goal = applyGoalCommand(goal, 'draft', { outcomes: outcomes.map(outcome), pr: 1, branch: `graphyard/${key.toLowerCase()}`, head: 'a'.repeat(40) }, { actor: planAuthor, at });
  goal = applyGoalCommand(goal, 'approve', { reason: 'Right' }, { actor: approver, at });
  return applyGoalCommand(goal, 'merged', { pr: 1, mergeSha: 'b'.repeat(40) }, { actor: master, at });
}
const criteria = (text: string) => [{ id: 'AC-1', text, proofs: ['unit:planned-behaviour'] }];
const item = (ref: string, outcomes: string[], plannedFiles: string[], dependsOn: string[] = []) =>
  ({ ref, title: `Build ${ref}`, description: `The ${ref} part`, type: 'feature' as const, priority: 2, outcomes, cases: outcomes.map(id => `${id}-case`), criteria: criteria(`${ref} works`), plannedFiles, dependsOn });
const note = 'Node and TypeScript server, one module per outcome under src/, Postgres for data, deployed to uat then production by the release pipeline.';
const goodPlan = (): GoalPlan => ({ note, items: [item('ui', ['signup'], ['src/signup/page.ts', 'src/api.ts'], ['api']), item('api', ['signup'], ['src/api.ts']), item('billing', ['billing'], ['src/billing/'])] });

function stubRunner(respond: (prompt: string) => unknown, prompts: string[], tools: string[]): Runner {
  return {
    name: 'stub',
    start<T>(prompt: string, options: RunOptions<T>) {
      prompts.push(prompt); tools.push(`${options.tool} ${options.env?.GRAPHYARD_PI_ROLE}`);
      let result: RunResult<T>;
      try { const parsed = options.validate(respond(prompt)); result = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
      catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
    },
  };
}
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard', repository, baseBranch: 'main',
  githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-planner', autoMerge: true, mergeMethod: 'merge', workers: [] });
const allWork = async () => (await store.pool.query('SELECT document FROM work_items ORDER BY id')).rows.map(row => row.document as Work);

test('unit:planner-plan-validation — a plan covers every approved outcome, names its cases, keeps parallel items off shared files and orders dependencies; one that fails is refused with the reason before approval', async () => {
  const { clearPlans, maxPlanRounds, planOrder, planRefusals, planJudgementTool, plansSettled, plannerStep, planTool } = await planner();
  clearPlans();
  const goal = mergedGoal('GOAL-1');
  assert.equal(goal.stage, 'planning', 'a merged acceptance hands the goal to the planner');
  assert.deepEqual(planRefusals(goal, goodPlan()), []);
  // Dependency order: each item after every item it depends on, otherwise as planned.
  assert.deepEqual(planOrder(goodPlan()).map(entry => entry.ref), ['api', 'ui', 'billing']);
  const chain: GoalPlan = { note, items: [item('c', ['signup'], ['src/x.ts'], ['b']), item('b', ['signup'], ['src/y.ts'], ['a']), item('a', ['signup', 'billing'], ['src/x.ts'])] };
  assert.deepEqual(planOrder(chain).map(entry => entry.ref), ['a', 'b', 'c']);
  assert.deepEqual(planRefusals(goal, chain), [], 'an item may share a file with one it lands after, through another item');

  const refused = (plan: GoalPlan) => planRefusals(goal, plan).join('; ');
  // Coverage: every approved outcome is served by at least one item.
  assert.match(refused({ note, items: [item('api', ['signup'], ['src/api.ts'])] }), /no item serves approved outcome billing/);
  // Overlap: two items neither of which depends on the other share no planned file, a directory included.
  assert.match(refused({ note, items: [item('api', ['signup'], ['src/api.ts']), item('billing', ['billing'], ['src/billing.ts', 'src/api.ts'])] }), /items api and billing may run in parallel yet both plan src\/api\.ts/);
  assert.match(refused({ note, items: [item('api', ['signup'], ['src/api.ts']), item('billing', ['billing'], ['src/'])] }), /items api and billing may run in parallel yet both plan src\/api\.ts/);
  // Every plannedFiles form counts: a dir/* or dir/** boundary meets the files under it.
  for (const wide of ['src/billing/**', 'src/billing/*'])
    assert.match(refused({ note, items: [item('api', ['signup'], ['src/billing/x.ts']), item('billing', ['billing'], [wide])] }), /items api and billing may run in parallel yet both plan src\/billing\/x\.ts/);
  // A criterion id an item names twice would be refused at create, after approval: it is refused before.
  assert.match(refused({ note, items: [{ ...item('api', ['signup'], ['src/api.ts']), criteria: [...criteria('one'), ...criteria('two')] }, item('billing', ['billing'], ['src/billing.ts'])] }), /item api names criterion AC-1 twice/);
  // Cases: each item names the required cases it must make pass, and only the goal's.
  assert.match(refused({ note, items: [{ ...item('api', ['signup'], ['src/api.ts']), cases: ['billing-case'] }, item('billing', ['billing'], ['src/billing.ts'])] }), /item api serves an outcome without naming the case that proves it: add signup-case/);
  assert.match(refused({ note, items: [{ ...item('api', ['signup'], ['src/api.ts']), cases: ['signup-case', 'other-case'] }, item('billing', ['billing'], ['src/billing.ts'])] }), /item api names case other-case, which GOAL-1 does not require/);
  assert.match(refused({ note, items: [item('api', ['signup', 'refunds'], ['src/api.ts']), item('billing', ['billing'], ['src/billing.ts'])] }), /item api serves refunds, which GOAL-1 did not approve/);
  // No item edits a required case or its contract binding.
  assert.match(refused({ note, items: [item('api', ['signup'], ['src/api.ts', 'e2e/cases/signup-case.json']), item('billing', ['billing'], ['e2e/contract.json'])] }), /item api plans e2e\/cases\/signup-case\.json: no item edits or weakens a required case.*item billing plans e2e\/contract\.json/);
  assert.match(refused({ note, items: [item('api', ['signup'], ['src/api.ts', 'e2e/cases/**']), item('billing', ['billing'], ['e2e/'])] }), /item api plans e2e\/cases\/\*\*: no item edits.*item billing plans e2e\//);
  // Dependencies: refs of this plan, no cycle.
  assert.match(refused({ note, items: [item('api', ['signup'], ['src/api.ts'], ['nowhere']), item('billing', ['billing'], ['src/billing.ts'])] }), /item api depends on nowhere, which is not another item of this plan/);
  const cycle: GoalPlan = { note, items: [item('api', ['signup'], ['src/api.ts'], ['billing']), item('billing', ['billing'], ['src/billing.ts'], ['api'])] };
  assert.match(refused(cycle), /items api, billing depend on each other in a cycle/);
  assert.throws(() => planOrder(cycle), /depend on each other in a cycle/);
  // The note is at most 400 words.
  assert.match(refused({ ...goodPlan(), note: Array.from({ length: 401 }, () => 'word').join(' ') }), /the architecture note is 401 words; it is at most 400/);
  // The model refuses such a plan outright, with every reason, so it never reaches an approver.
  assert.throws(() => applyGoalCommand(goal, 'plan', { note, items: [item('api', ['signup'], ['src/api.ts'])] }, { actor: planAuthor, at: new Date().toISOString() }),
    (error: Error & { status?: number }) => error.status === 422 && /Plan refused for GOAL-1: no item serves approved outcome billing/.test(error.message));

  // The role: registered, with its one Pi tool per run whose parameters match the plan the loop validates.
  assert.ok((registryRoles as readonly string[]).includes('planner'));
  assert.equal(roleSchema.parse({ name: 'planner', accounts: [], concurrency: 1 }).name, 'planner');
  assert.equal(proposedConcurrency.planner, 1);
  const { planParameters, planJudgementParameters } = pi as unknown as Record<string, pi.JsonSchema>;
  assert.deepEqual(pi.graphyardTools('planner').map(tool => tool.name), [planTool]);
  assert.deepEqual(pi.graphyardTools('plan-judge').map(tool => tool.name), [planJudgementTool]);
  assert.deepEqual(pi.schemaErrors(planParameters, { goal: 'GOAL-1', ...goodPlan() }), []);
  assert.deepEqual(pi.schemaErrors(planJudgementParameters, { goal: 'GOAL-1', verdict: 'approve', reason: 'Small items in a sensible order' }), []);

  // The loop, with a stubbed runner: an overlapping plan is refused before approval with its reason, never posted, and the next run is told why.
  let current: Goal = goal;
  const prompts: string[] = [], tools: string[] = [], posted: GoalPlan[] = [];
  const plans: unknown[] = [{ goal: goal.key, note, items: [item('api', ['signup'], ['src/api.ts']), item('billing', ['billing'], ['src/api.ts'])] }, { goal: goal.key, ...goodPlan() }];
  const fx: PlannerEffects = {
    settings: diagnosticianSettings({}), cwd: process.cwd(),
    goals: async () => [current],
    runner: async (role, attempt) => ({ runner: stubRunner(() => role === 'plan' ? plans.shift() : { goal: goal.key, verdict: 'approve', reason: 'Fine' }, prompts, tools), runtime: 'stub', model: attempt }),
    plan: async (target, plan) => { posted.push(plan); current = applyGoalCommand(target, 'plan', plan, { actor: planAuthor, at: new Date().toISOString() }); return current; },
    invalid: async (target, reason) => (current = applyGoalCommand(target, 'plan-invalid', { reason }, { actor: planAuthor, at: new Date().toISOString() })),
    judge: async target => target, release: async target => target, deliver: async target => target,
  };
  const state = emptyDaemonState(config);
  let clock = Date.parse('2026-10-07T00:00:00Z');
  const step = async (advance = 60_000) => {
    clock += advance;
    await plannerStep({ config, state, effects: { planner: fx, persist: async () => {} }, now: () => clock, clock, snapshot: { work: [] }, performed: [], isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as unknown as Cycle);
    await plansSettled();
  };
  await step();
  assert.deepEqual(tools, [`${planTool} planner`]);
  assert.match(prompts[0], /at most 400 words/); assert.match(prompts[0], /signup-case/);
  await step();
  assert.deepEqual(posted, [], 'a refused plan never reaches an approver');
  assert.equal(state.actions[`planner:${goal.id}`].state, 'failed');
  assert.match(state.actions[`planner:${goal.id}`].detail, /refused before approval: items api and billing may run in parallel yet both plan src\/api\.ts/);
  // The refusal is recorded on the goal, so it counts toward the plan rounds whatever restarts the loop.
  assert.equal(current.stage, 'planning'); assert.equal(current.planDrafts, 1); assert.match(current.planRefusal!.reason, /may run in parallel/);
  await step(); assert.equal(tools.length, 1, 'the next plan waits out the retry');
  await step(60 * 60_000);
  assert.match(prompts[1], /items api and billing may run in parallel/, 'the next run answers the refusal');
  await step();
  assert.equal(posted.length, 1); assert.equal(current.stage, 'plan-review'); assert.equal(current.plan?.author, planAuthor.id); assert.equal(current.planDrafts, 2);
  assert.match(state.actions[`planner:${goal.id}`].detail, /Recorded GOAL-1's plan: ui after api; api; billing; it awaits an approver other than its author/);
  // Past its plan rounds, a refused goal is the master's.
  assert.match(goalSummary({ ...goal, planDrafts: maxPlanRounds }).next!.who, new RegExp(`${maxPlanRounds} plans were refused`));

  // Plans refused before approval use up the rounds too: a planner that keeps overlapping is run maxPlanRounds times, an hour apart, then never again.
  let stubborn: Goal = mergedGoal('GOAL-2');
  const overlap = () => ({ goal: stubborn.key, note, items: [item('api', ['signup'], ['src/shared/**']), item('billing', ['billing'], ['src/shared/billing.ts'])] });
  const stubbornRuns: string[] = [];
  fx.goals = async () => [stubborn];
  fx.runner = async (_role, attempt) => ({ runner: stubRunner(overlap, stubbornRuns, []), runtime: 'stub', model: attempt });
  fx.invalid = async (target, reason) => (stubborn = applyGoalCommand(target, 'plan-invalid', { reason }, { actor: planAuthor, at: new Date().toISOString() }));
  for (let hour = 0; hour < maxPlanRounds + 2; hour++) { await step(60 * 60_000); await step(); }
  assert.equal(stubbornRuns.length, maxPlanRounds, 'one paid run per round, and none past the cap');
  assert.equal(stubborn.planDrafts, maxPlanRounds); assert.equal(stubborn.stage, 'planning');
  assert.match(state.actions[`planner:${stubborn.id}`].detail, /the loop plans no more and leaves it to the master/);
  assert.match(goalSummary(stubborn).next!.who, /^master: /);
});

test('unit:planner-approval-and-dispatch-order — only an approver who did not write the plan approves it, only then are its items created and released with their dependencies, the dispatcher holds each until those are delivered, and the goal moves planned, delivering, delivered', async () => {
  const { clearPlans, currentGoal, planItemInput, planJudgementTool, planOrder, plansSettled, plannerStep, planTool, servedInProduction } = await planner();
  clearPlans();
  // A goal whose acceptance merged, in the ledger as the land route leaves it.
  const goal = mergedGoal('GOAL-1');
  await appendGoal(store.pool, master.id, 'record', goal, {});
  const read = async () => (await ok(master, 'GET', `goals/${goal.key}`)).goal as Goal;
  assert.equal((await read()).stage, 'planning');
  // A goal recorded before planning existed said `planned` for an approved, unmerged draft: it reads as accepted.
  assert.equal(currentGoal({ ...goal, stage: 'planned', merged: null }).stage, 'accepted');
  assert.equal(currentGoal(goal).stage, 'planning');

  // Nothing is released before a plan is approved.
  assert.equal((await call(planAuthor, 'POST', `goals/${goal.key}/release`, {})).status, 409);
  const overlapping = await call(planAuthor, 'POST', `goals/${goal.key}/plan`, { note, items: [item('api', ['signup'], ['src/api.ts']), item('billing', ['billing'], ['src/api.ts'])] });
  assert.equal(overlapping.status, 422); assert.match(overlapping.text, /may run in parallel yet both plan src\/api\.ts/);

  // The loop drives the rest, as the planner's effects do: the plan posted by its author, judged by the approver, released, delivered.
  const prompts: string[] = [], tools: string[] = [];
  let verdict: { verdict: 'approve' | 'refuse'; reason: string } = { verdict: 'refuse', reason: 'Split the billing item; it is too large for one worker' };
  let failRelease = 1;
  const fx: PlannerEffects = {
    settings: diagnosticianSettings({}), cwd: process.cwd(),
    goals: async () => (await ok(master, 'GET', 'goals?open=1')).goals,
    runner: async (role, attempt, target) => ({ runner: stubRunner(() => role === 'plan' ? { goal: target.key, ...goodPlan() } : { goal: target.key, ...verdict }, prompts, tools), runtime: 'stub', model: attempt }),
    plan: (target, plan) => ok(planAuthor, 'POST', `goals/${target.key}/plan`, plan),
    invalid: (target, reason) => ok(planAuthor, 'POST', `goals/${target.key}/plan-invalid`, { reason }),
    judge: (target, judgement) => ok(approver, 'POST', `goals/${target.key}/plan-${judgement.verdict}`, { reason: judgement.reason }),
    release: async target => {
      if (failRelease-- > 0) {
        // The control plane created the first item, then died; that create's receipt is long gone by the retry.
        const plan = target.plan!, first = planOrder(plan)[0];
        await engine.execute(planAuthor, 'create', null, planItemInput({ ...target, plan, planApproval: target.planApproval! }, first, new Map()), randomUUID());
        throw new Error('Graphyard refused goals (502)');
      }
      return ok(planAuthor, 'POST', `goals/${target.key}/release`, {});
    },
    deliver: (target, items, reason) => ok(planAuthor, 'POST', `goals/${target.key}/deliver`, { items, reason }),
  };
  const state = emptyDaemonState(config);
  let clock = Date.parse('2026-10-07T00:00:00Z');
  const step = async (advance = 6 * 60_000) => {
    clock += advance;
    await plannerStep({ config, state, effects: { planner: fx, persist: async () => {} }, now: () => clock, clock, snapshot: { work: await allWork() }, performed: [], isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as unknown as Cycle);
    await plansSettled();
  };
  await step(); await step();
  let current = await read();
  assert.equal(current.stage, 'plan-review'); assert.equal(current.plan?.author, planAuthor.id);
  // Its author never approves it.
  const own = await call(planAuthor, 'POST', `goals/${goal.key}/plan-approve`, { reason: 'Mine is good' });
  assert.equal(own.status, 403); assert.match(own.text, /Self-approval refused: plan-author authored the plan of GOAL-1/);
  assert.equal((await call(planAuthor, 'POST', `goals/${goal.key}/release`, {})).status, 409, 'a plan awaiting approval releases nothing');
  assert.deepEqual(await allWork(), [], 'no item exists before the plan is approved');
  // The approver refuses: the goal is planned again, the refusal answered by the next run.
  await step(); await step();
  current = await read();
  assert.equal(current.stage, 'planning'); assert.equal(current.planRefusal?.by, approver.id);
  verdict = { verdict: 'approve', reason: 'Three small items; ui after api, billing beside them on its own files' };
  await step(); await step();
  assert.match(prompts.at(-1)!, /Split the billing item/);
  await step(); await step();
  current = await read();
  assert.equal(current.stage, 'planned'); assert.equal(current.planApproval?.by, approver.id); assert.equal(current.planDrafts, 2);
  assert.deepEqual(tools, [`${planTool} planner`, `${planJudgementTool} plan-judge`, `${planTool} planner`, `${planJudgementTool} plan-judge`]);
  assert.deepEqual(await allWork(), [], 'approved, nothing is created until the release');

  // Released in dependency order, each with the ids of the items it depends on; a failed release is retried and makes nothing twice.
  await step();
  assert.equal((await allWork()).length, 1, 'the failed release left its first item behind');
  assert.match(state.actions[`planner:${goal.id}`].detail, /Could not release GOAL-1's approved plan/);
  await step(10 * 60_000);
  current = await read();
  assert.equal(current.stage, 'delivering');
  assert.deepEqual(current.items!.map(entry => entry.ref), ['ui', 'api', 'billing']);
  const again: Goal = await ok(planAuthor, 'POST', `goals/${goal.key}/release`, {});
  assert.deepEqual(again.items, current.items, 'a repeated release answers the items already made');
  let work = await allWork();
  assert.equal(work.length, 3, 'one work item per planned item: the retry found the item the failed release made by its mark, not its expired receipt');
  const byRef = (ref: string) => work.find(entry => entry.id === current.items!.find(planned => planned.ref === ref)!.id)!;
  const [api, ui, billing] = [byRef('api'), byRef('ui'), byRef('billing')];
  assert.ok(Number(api.key.split('-')[1]) < Number(ui.key.split('-')[1]), 'created in dependency order');
  assert.deepEqual(ui.dependencies, [api.id]); assert.deepEqual(api.dependencies, []); assert.deepEqual(billing.dependencies, []);
  for (const entry of work) assert.ok(entry.ready, `${entry.key} is released`);
  assert.deepEqual(ui.plannedFiles, ['src/signup/page.ts', 'src/api.ts']);
  assert.match(ui.description, /must make the required uat case e2e\/cases\/signup-case\.json pass/);
  assert.match(ui.description, /Architecture note for GOAL-1:\nNode and TypeScript server/);
  // The planned items are implementations: the required cases stay protected from them.
  assert.equal(protectedCaseRefusals(ui, { files: ['e2e/cases/signup-case.json'] } as never, [current]).length, 1);

  // The dispatcher launches nothing before the items it depends on are delivered.
  const at = new Date().toISOString();
  assert.doesNotThrow(() => assertDispatchable(api, work, at));
  assert.doesNotThrow(() => assertDispatchable(billing, work, at));
  assert.throws(() => assertDispatchable(ui, work, at), new RegExp(`Dispatch blocked by unfinished dependencies: ${api.key}`));
  const deliver = async (target: Work, delivery: Record<string, unknown> | null) => store.pool.query(`UPDATE work_items SET document = document || $2::jsonb WHERE id = $1`,
    [target.id, JSON.stringify({ stage: 'done', ...(delivery ? { delivery } : {}) })]);
  const merged = { mergedAt: at, mergeSha: 'c'.repeat(40), authorizationRevision: 1 };
  const deployment = { sha: 'c'.repeat(40), mergeSha: 'c'.repeat(40), source: 'endpoint', observedAt: at, covers: 'exact', at, observer: master.id };
  await deliver(api, { ...merged, deployment });
  work = await allWork();
  assert.doesNotThrow(() => assertDispatchable(work.find(entry => entry.id === ui.id)!, work, at), 'once its dependency is delivered, ui is dispatched');

  // Delivered only once every item is done and production serves it.
  await step(); await step(5 * 60_000);
  current = await read();
  assert.equal(current.stage, 'delivering');
  assert.match(state.actions[`planner:${goal.id}`].detail, new RegExp(`${ui.key}, ${billing.key} are not yet done and served by production`));
  const early = await call(planAuthor, 'POST', `goals/${goal.key}/deliver`, { items: [api.key], reason: 'Said so' });
  assert.equal(early.status, 422); assert.match(early.text, new RegExp(`name ${ui.key}, ${billing.key} too`));
  await deliver(ui, merged);
  // A default-policy item merged with no deployment observed covering it is not served either.
  assert.equal(servedInProduction((await allWork()).find(entry => entry.id === ui.id)), false);
  // A smoke-gated item merged but not yet deployed is not served.
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{policy,deploySmoke}', 'true') WHERE id = $1`, [billing.id]);
  await deliver(billing, merged);
  assert.equal(servedInProduction((await allWork()).find(entry => entry.id === billing.id)), false);
  const unserved = await call(planAuthor, 'POST', `goals/${goal.key}/deliver`, { items: [api.key, ui.key, billing.key], reason: 'All merged' });
  assert.equal(unserved.status, 422); assert.match(unserved.text, new RegExp(`${ui.key}, ${billing.key} are not delivered`), 'ui has no observed deployment and billing no smoke proof');
  await step(5 * 60_000);
  assert.equal((await read()).stage, 'delivering');
  await deliver(billing, { ...merged, deployment, smoke: { evidenceId: randomUUID(), result: 'pass', sha: 'c'.repeat(40), mergeSha: 'c'.repeat(40), producer: 'smoke', at, executed: 1, skipped: 0 } });
  await step(5 * 60_000);
  assert.equal((await read()).stage, 'delivering', 'ui merged, but production was never observed serving it');
  await deliver(ui, { ...merged, deployment });
  await step(5 * 60_000);
  current = await read();
  assert.equal(current.stage, 'delivered');
  assert.match(state.actions[`planner:${goal.id}`].detail, /GOAL-1 is delivered/);
  const history = (await ok(master, 'GET', `goals/${goal.key}`)).history.map((entry: any) => `${entry.kind}:${entry.actor}:${entry.stage}`);
  assert.deepEqual(history, [`goal.recorded:${master.id}:planning`, `goal.plan:${planAuthor.id}:plan-review`, `goal.plan-refuse:${approver.id}:planning`, `goal.plan:${planAuthor.id}:plan-review`,
    `goal.plan-approve:${approver.id}:planned`, `goal.released:${planAuthor.id}:delivering`, `goal.deliver:${planAuthor.id}:delivered`]);
});

test('manual:goal-pipeline-docs-review — the docs describe the goal pipeline (intake, acceptance, approval, planning, approval, delivery) and that the master no longer hand-decomposes goals, within the word budget', async () => {
  const page = (name: string) => readFile(new URL(`../docs/${name}`, import.meta.url), 'utf8');
  const [guide, works, validation] = await Promise.all([page('master-agent.md'), page('how-graphyard-works.md'), page('validation.md')]);
  assert.match(guide, /no longer hand-decomposes goals/);
  assert.match(guide, /\(how-graphyard-works\.md#from-goal-to-work-items\)/);
  assert.match(works, /^## From goal to work items$/m);
  assert.match(works, /intake, acceptance, approval, planning, approval and delivery/);
  for (const fragment of ['`planner` role', 'at most 400 words', '`plannedFiles`', 'refused with the reason', 'Another identity approves the plan', '`planned`, then `delivering`', 'before its dependencies are delivered', '`delivered` once every item is done and production serves it'])
    assert.ok(works.includes(fragment), `docs/how-graphyard-works.md states ${fragment}`);
  assert.match(validation, /`goal deliver` needs each done and served in production/);
  for (const [name, text] of [['master-agent.md', guide], ['how-graphyard-works.md', works], ['validation.md', validation]] as const)
    assert.ok(text.split(/\s+/).filter(Boolean).length <= 1000, `docs/${name} stays within its headroom`);
});
