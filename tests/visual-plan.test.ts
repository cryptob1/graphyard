import { test } from 'node:test';
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal } from '../src/model.js';
import { createSchema } from '../src/model/work.js';
import { goalPlanSchema, planItemInput, planOrder, planRefusals, plainSentences, type GoalPlan } from '../src/model/goal-plan.js';
import { applyGoalCommand, recordGoal, type Goal } from '../src/model/goal.js';
import { plannerPrompt } from '../src/daemon/planner.js';
import { flowOrder, planFlowchart, planItemState } from '../web/visual-plan.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2011: plan summary and per-item plain sentences on the payload; optional summary on create;
// flowchart boxes coloured by Todo/Doing/Checking/Done in dependency order.

const repository = 'owner/visual-plan';
const admin: Principal = { id: 'visual-admin', role: 'admin', sessionKind: 'ai' };
const credentials = [{ ...admin, token: `visual-admin-${'x'.repeat(32)}` }];
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>;

const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
});
before(async () => {
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('visual-plan'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('visual_plan_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/visual_plan_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const criteria = (text: string) => [{ id: 'AC-1', text, proofs: ['unit:visual-plan'] }];
const item = (ref: string, dependsOn: string[] = []) => ({
  ref, title: `Build ${ref}`, plain: `People get the ${ref} piece.`, description: `The ${ref} work`, type: 'feature' as const, priority: 2,
  outcomes: ['signup'], cases: ['signup-case'], criteria: criteria(`${ref} works`), plannedFiles: [`src/${ref}.ts`], dependsOn,
});
const note = 'Node and TypeScript under src/, Postgres for data, deployed by the release pipeline.';
const summary = 'Customers can sign up. The build lands the API before the page. Each piece is one worker change.';
const plan = (): GoalPlan => ({ summary, note, items: [item('page', ['api']), item('api'), item('billing'), item('notify', ['billing'])] });

function mergedGoal(): Goal {
  const at = new Date().toISOString();
  let goal = recordGoal({ statement: 'Customers can sign up', users: ['Customers'], constraints: [], deployTarget: 'uat' }, 'GOAL-1', { actor: admin, at });
  const outcome = { id: 'signup', title: 'A customer can sign up', criteria: ['The signup page answers'],
    case: { id: 'signup-case', title: 'signup answers', description: 'A customer reads the page.', tags: ['api'], target: 'uat', required: true,
      steps: [{ kind: 'http' as const, name: 'read', method: 'GET' as const, path: '/api/board', status: 200 }] } };
  goal = applyGoalCommand(goal, 'draft', { outcomes: [outcome], pr: 1, branch: 'graphyard/goal-1', head: 'a'.repeat(40) }, { actor: admin, at });
  goal = applyGoalCommand(goal, 'approve', { reason: 'Right' }, { actor: { id: 'other-admin', role: 'admin', sessionKind: 'ai' }, at });
  return applyGoalCommand(goal, 'merged', { pr: 1, mergeSha: 'b'.repeat(40) }, { actor: admin, at });
}

test('unit:plan-plain-fields — the planner prompt asks for a summary of at most 3 plain sentences and a one-sentence plain per item; the schema stores them and refuses a payload without them naming the missing field', () => {
  const prompt = plannerPrompt({ repository }, mergedGoal());
  assert.match(prompt, /summary of at most 3 plain sentences/);
  assert.match(prompt, /plain one-sentence description a non-engineer understands/);
  assert.deepEqual(plainSentences(summary).length, 3);
  assert.deepEqual(goalPlanSchema.parse(plan()).summary, summary);
  assert.deepEqual(goalPlanSchema.parse(plan()).items.map(entry => entry.plain), plan().items.map(entry => entry.plain));
  const missingSummary = goalPlanSchema.safeParse({ note, items: plan().items });
  assert.equal(missingSummary.success, false);
  assert.match(JSON.stringify(missingSummary.error!.issues), /summary/);
  const missingPlain = goalPlanSchema.safeParse({ summary, note, items: plan().items.map(({ plain: _p, ...rest }) => rest) });
  assert.equal(missingPlain.success, false);
  assert.match(JSON.stringify(missingPlain.error!.issues), /plain/);
  assert.match(planRefusals(mergedGoal(), { ...plan(), summary: '' } as GoalPlan).join('; '), /summary is missing/);
  assert.match(planRefusals(mergedGoal(), { ...plan(), items: [{ ...item('api'), plain: '' }] } as GoalPlan).join('; '), /plain is missing/);
});

test('unit:item-plain-summary — planItemInput copies plain onto summary; master create stores an optional summary', async () => {
  const goal = mergedGoal();
  const planned = plan().items[1];
  const input = planItemInput({ ...goal, plan: { ...plan(), author: 'planner', draftedAt: new Date().toISOString() }, planApproval: { by: 'approver' } }, planned, new Map());
  assert.equal(input.summary, planned.plain);
  const parsed = createSchema.parse({ title: 'Hand-filed item', description: 'detail', summary: 'A plain sentence for readers.', criteria: criteria('It works'), plannedFiles: ['src/x.ts'] });
  assert.equal(parsed.summary, 'A plain sentence for readers.');
  // master create / POST create: the optional summary is stored on the work document.
  const created = await engine.execute(admin, 'create', null, {
    title: 'Visual plan summary item', description: 'Full detail lives under Details.', summary: 'People read this sentence first.',
    criteria: criteria('The summary is stored'), plannedFiles: ['src/visual-plan.ts'],
  }, randomUUID());
  assert.equal(created.summary, 'People read this sentence first.');
});test('integration:goal-visual-plan — a four-item plan lays boxes in dependency order with an arrow per dependsOn and Todo/Doing/Checking/Done colours; browser-tests/visual-plan.spec.ts loads the goal page and checks Play and the Details fold', async () => {
  assert.deepEqual(planOrder(plan()).map(entry => entry.ref), ['api', 'page', 'billing', 'notify']);
  assert.deepEqual(flowOrder(plan().items).map(entry => entry.ref), ['api', 'page', 'billing', 'notify']);
  assert.equal(planItemState('backlog'), 'Todo');
  assert.equal(planItemState('build'), 'Doing');
  assert.equal(planItemState('review'), 'Checking');
  assert.equal(planItemState('done'), 'Done');
  const workByRef = new Map([
    ['api', { id: '1', key: 'GY-1', stage: 'done' }],
    ['page', { id: '2', key: 'GY-2', stage: 'build' }],
    ['billing', { id: '3', key: 'GY-3', stage: 'review' }],
    ['notify', { id: '4', key: 'GY-4', stage: 'ready' }],
  ]);
  const flow = planFlowchart(plan().items, workByRef);
  assert.deepEqual(flow.order, ['api', 'page', 'billing', 'notify']);
  assert.deepEqual(flow.boxes.map(box => box.state), ['Done', 'Doing', 'Checking', 'Todo']);
  assert.ok(flow.arrows.some(arrow => arrow.from === 'api' && arrow.to === 'page'));
  assert.ok(flow.arrows.some(arrow => arrow.from === 'billing' && arrow.to === 'notify'));
  assert.equal(flow.boxes.length, 4);
  // A plan saved before GY-2011 has no plain sentence: its boxes show the item title instead of throwing.
  const legacy = planFlowchart([{ ref: 'old', title: 'Old item', dependsOn: [] }, { ref: 'bare', dependsOn: ['old'] }]);
  assert.deepEqual(legacy.boxes.map(box => box.plain), ['Old item', 'bare']);
  // The browser suite's own case (AC-2): loads /goals/KEY, checks boxes, arrows, colours, Play and the item Details fold.
  const spec = await readFile(new URL('../browser-tests/visual-plan.spec.ts', import.meta.url), 'utf8');
  assert.match(spec, /integration:goal-visual-plan/);
  assert.match(spec, /\/goals\/GOAL-V/);
  assert.match(spec, /data-state="Done"/);
  assert.match(spec, /data-state="Doing"/);
  assert.match(spec, /data-state="Checking"/);
  assert.match(spec, /data-state="Todo"/);
  assert.match(spec, /Play plan walkthrough/);
  assert.match(spec, /item-details-fold/);
  assert.match(spec, /data-plain-summary/);
});
