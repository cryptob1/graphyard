import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Observation, Principal, Work } from '../src/model.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { applyDecompositionEvent, decompositionHold, decompositionSettings, decompositionTool, decompositionWanted, linkChildren, sizeBoundsExceeded, splitParentDelivery,
  validateSplitCriteria, type DecompositionEvent } from '../src/decomposition.js';
import { clearDecompositionRuns, decompositionSettled, decompositionStep } from '../src/decomposition-step.js';
import { decompositionPayloadSchema, type DecompositionPayload } from '../src/runner/payloads.js';
import type { Run, RunOptions, RunResult, Runner } from '../src/runner/types.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import { buildMasterStatus } from '../src/master/status.js';
import { masterConfigSchema, masterRunSchema } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionAccount, nextAction } from '../src/model/next-action.js';
import { graphyardTools } from '../integrations/pi/index.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1126: a broad item is split into small, independently mergeable child items before its
// first dispatch. The loop's step runs one Pi session (a fake runner here) that proposes the
// children; the control plane validates the proposal against the parent and makes the split; the
// parent is never dispatched and is delivered when its last child is.

const NOW = Date.parse('2026-10-03T06:00:00.000Z');
const settings = decompositionSettings({});
const criteria = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'].map((id, index) => ({ id, text: `Behaviour ${index + 1} holds.`, proofs: [`unit:behaviour-${index + 1}`] }));

function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: structuredClone(criteria),
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/', 'web/', 'tests/', 'docs/'], stage: 'ready', ready: true, revision: 2, policyRevision: 1,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), stageEnteredAt: new Date(NOW).toISOString(),
    epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}

/** The split this suite's decomposition session proposes for a five-criterion parent. */
const proposal: DecompositionPayload = decompositionPayloadSchema.parse({
  reason: 'The model, the loop step and the status view merge separately.',
  children: [
    { title: 'Model', criteria: ['AC-1', 'AC-2'], plannedFiles: ['src/decomposition.ts', 'tests/item-split.test.ts'] },
    { title: 'Loop step', criteria: ['AC-3', 'AC-4'], plannedFiles: ['src/daemon/cycle-dispatch.ts'], after: [0] },
    { title: 'Status and docs', criteria: ['AC-5'], plannedFiles: ['src/master/status.ts', 'docs/coordination.md'], after: [0] },
  ],
});

/** A Pi stand-in: records every start and settles as its scenario says, validating the payload as the runner does. */
function fakeRunner(scenario: (prompt: string) => RunResult<unknown>) {
  const starts: { prompt: string; options: RunOptions<unknown> }[] = [];
  const runner: Runner = {
    name: 'pi',
    start<T>(prompt: string, options: RunOptions<T>): Run<T> {
      starts.push({ prompt, options: options as RunOptions<unknown> });
      let resolve!: (result: RunResult<T>) => void;
      const result = new Promise<RunResult<T>>(settle => { resolve = settle; });
      queueMicrotask(() => {
        const outcome = scenario(prompt);
        if (!outcome.ok) return resolve(outcome as RunResult<T>);
        try { resolve({ ...outcome, payload: options.validate(outcome.payload), payloads: [] } as RunResult<T>); }
        catch (error) { resolve({ ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }); }
      });
      return { id: `run-${starts.length}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: () => result };
    },
  };
  return { runner, starts };
}
const submitted = (payload: unknown): RunResult<unknown> => ({ ok: true, tool: decompositionTool, payload, payloads: [payload] });

/** The control plane as the step sees it: the server's own transition, with the store's numbering of the children. */
function plane(items: Work[]) {
  const events: { key: string; event: DecompositionEvent }[] = [];
  let number = 100;
  const record = async (work: Work, event: DecompositionEvent) => {
    events.push({ key: work.key, event });
    const stored = items.find(entry => entry.id === work.id)!;
    const children = applyDecompositionEvent(stored, event, 'graphyard-master', new Date(NOW));
    for (const child of children) { child.key = `GY-${++number}`; items.push(child); }
    if (children.length) linkChildren(stored, children);
    return stored;
  };
  return { events, record };
}
const step = (items: Work[], runner: Runner, record: (work: Work, event: DecompositionEvent) => Promise<unknown>) =>
  decompositionStep({ items: [...items], clock: NOW, settings, config: { repository: 'owner/project' }, cwd: process.cwd(), runner, model: 'zai/glm-5.3-flash', record });
const dispatchable = (work: Work, all: Work[]) => { try { assertDispatchable(work, all, new Date(NOW).toISOString()); return null; } catch (error) { return (error as Error).message; } };

test('unit:broad-items-split-before-dispatch — an item over the size bounds is split before first dispatch into children covering its criteria exactly, with narrower plannedFiles and ordering dependencies; an item within the bounds or opted out is dispatched unchanged', async t => {
  t.after(clearDecompositionRuns);
  // The bounds are master.json settings with defaults that leave an ordinary item whole.
  assert.equal(masterRunSchema.parse({}).decomposition, undefined);
  assert.deepEqual(decompositionSettings(masterRunSchema.parse({ decomposition: { maxCriteria: 6 } })).maxCriteria, 6);
  assert.deepEqual(sizeBoundsExceeded(item('GY-9', { criteria: criteria.slice(0, 3), plannedFiles: ['src/decomposition.ts', 'tests/item-split.test.ts', 'docs/coordination.md'] }), settings), [], 'three criteria and three named files are within the bounds');

  const prerequisite = item('GY-1', { stage: 'done' });
  const broad = item('GY-2', { dependencies: [prerequisite.id], exclusiveResources: ['github-app'], documentation: { id: 'DOCS', text: 'Documentation reflects this change.', paths: ['docs/'] } as Work['documentation'] });
  const small = item('GY-3', { criteria: criteria.slice(0, 2), plannedFiles: ['src/decomposition.ts', 'docs/coordination.md'] });
  const optedOut = item('GY-4', { split: false });
  const dispatched = item('GY-5', { epoch: 1, implementers: ['graphyard-codex-1'] });
  const items = [prerequisite, broad, small, optedOut, dispatched];
  assert.ok(decompositionWanted(broad, settings)!.some(reason => /5 criteria, over 4/.test(reason)) && decompositionWanted(broad, settings)!.some(reason => /4 root-level planned directories/.test(reason)));

  const { runner, starts } = fakeRunner(() => submitted(proposal));
  const { events, record } = plane(items);
  const first = await step(items, runner, record);
  assert.deepEqual([...first.held], [broad.id], 'dispatch waits on the broad item only while it is being split');
  assert.equal(starts.length, 1, 'the item within the bounds, the opted-out item and the already-dispatched item get no session');
  assert.equal(starts[0].options.tool, decompositionTool);
  assert.equal(starts[0].options.env?.GRAPHYARD_PI_ROLE, 'decomposition');
  assert.match(starts[0].prompt, /AC-5: Behaviour 5 holds\./, 'the session is given every criterion to share out');
  assert.equal(decompositionHold(broad, NOW), true, 'recorded as running before it launches');
  assert.equal(nextAction(broad, items, new Date(NOW)), null, 'nextAction has no action while decomposition is in progress');
  assert.equal(actionAccount(broad, items, new Date(NOW)).wait?.kind, 'session', 'actionAccount waits on decomposition session');
  assert.match(actionAccount(broad, items, new Date(NOW)).wait!.detail, /is being split into child items before dispatch/);
  assert.deepEqual(graphyardTools('decomposition').map(tool => tool.name), [decompositionTool], 'the Pi extension registers the decomposition tool for its role');

  await decompositionSettled();
  assert.deepEqual(events.map(entry => entry.event.event), ['started', 'decided']);
  assert.equal(broad.decomposition?.state, 'split');
  const children = broad.children!.map(key => items.find(entry => entry.key === key)!);
  assert.deepEqual(children.map(child => child.key), ['GY-101', 'GY-102', 'GY-103'], 'children are ordinary numbered items');
  // The children's criteria are exactly the parent's: every one, once, with the parent's own text and proofs.
  assert.deepEqual(children.flatMap(child => child.criteria).sort((a, b) => a.id.localeCompare(b.id)), broad.criteria);
  for (const child of children) {
    assert.equal(child.parent, broad.key);
    assert.ok(child.plannedFiles!.length && child.plannedFiles!.every(path => !path.endsWith('/')), `${child.key} plans named files, narrower than the parent's directories`);
    assert.ok(child.dependencies.includes(prerequisite.id), `${child.key} keeps the parent's dependency`);
    assert.deepEqual(child.exclusiveResources, ['github-app'], `${child.key} keeps the parent's exclusive resources`);
    assert.equal(child.documentation?.id, 'DOCS', `${child.key} carries the documentation obligation`);
    assert.equal(child.ready, true, `${child.key} is released as its parent was`);
  }
  assert.deepEqual(children[1].dependencies, [prerequisite.id, children[0].id], 'a child that builds on an earlier one depends on it');
  assert.equal(decompositionHold(broad, NOW), false);

  // Dispatch: the parent never; its first child, the small item and the opted-out item as they are.
  assert.match(dispatchable(broad, items)!, /was split into GY-101, GY-102, GY-103 before dispatch/);
  assert.equal(dispatchable(children[0], items), null);
  assert.match(dispatchable(children[1], items)!, /GY-101/, 'the second child waits for the first');
  assert.equal(dispatchable(small, items), null);
  assert.equal(dispatchable(optedOut, items), null);
  assert.deepEqual([small, optedOut].map(entry => [entry.children, entry.decomposition, entry.criteria.length]), [[undefined, undefined, 2], [undefined, undefined, 5]], 'unchanged');
  assert.equal(nextAction(broad, items, new Date(NOW))?.kind ?? null, null, 'the parent itself has no action: it waits on its children');

  // One run per item: the next cycle starts nothing.
  const again = await step(items, runner, record);
  assert.equal(starts.length, 1); assert.equal(again.held.size, 0);

  // Concurrency limit holds excess broad items from dispatch until a slot opens
  const cSettings = decompositionSettings({ concurrency: 2 });
  const b1 = item('GY-81'), b2 = item('GY-82'), b3 = item('GY-83');
  const { runner: cRunner, starts: cStarts } = fakeRunner(() => submitted(proposal));
  const { record: cRecord } = plane([b1, b2, b3]);
  const cStep = await decompositionStep({ items: [b1, b2, b3], clock: NOW, settings: cSettings, config: { repository }, cwd: process.cwd(), runner: cRunner, model: 'm', record: cRecord });
  assert.equal(cStarts.length, 2, 'concurrency limits live runs to 2');
  assert.deepEqual([...cStep.held].sort(), [b1.id, b2.id, b3.id].sort(), 'all three broad items are held from dispatch');
  await decompositionSettled();
});

test('unit:broad-items-split-before-dispatch — a split that drops, duplicates or invents a criterion, does not narrow the scope or orders a child after a later one is refused, and that run, a failed run or a kept-whole answer leaves the item to be dispatched unchanged', async t => {
  t.after(clearDecompositionRuns);
  const parent = item('GY-20');
  const refuse = (children: unknown[], pattern: RegExp) => {
    const payload = decompositionPayloadSchema.parse({ reason: 'r', children });
    const candidate = structuredClone(parent);
    candidate.decomposition = { state: 'running', startedAt: new Date(NOW).toISOString(), endedAt: null, runtime: 'pi', model: 'm', timeoutMs: 60_000, bounds: ['b'], reason: null, children: [], failure: null, recordedBy: 'x' };
    assert.throws(() => applyDecompositionEvent(candidate, { event: 'decided', payload }, 'graphyard-master', new Date(NOW)), pattern);
  };
  const base = proposal.children;
  refuse([base[0], base[1]], /drops AC-5/);
  refuse([base[0], { ...base[1], criteria: ['AC-2', 'AC-3', 'AC-4'] }, base[2]], /AC-2 of GY-20 is given to child 1 and child 2/);
  refuse([base[0], { ...base[1], criteria: ['AC-3', 'AC-4', 'AC-9'] }, base[2]], /names AC-9, which is not a criterion/);
  refuse([base[0], { ...base[1], plannedFiles: ['lib/other.ts'] }, base[2]], /outside GY-20's planned files/);
  refuse([base[0], { ...base[1], plannedFiles: ['src/', 'web/', 'tests/', 'docs/'] }, base[2]], /strictly narrower/);
  refuse([{ ...base[0], after: [1] }, base[1], base[2]], /must land after an earlier child only/);
  assert.throws(() => validateSplitCriteria(parent, []), /drops AC-1, AC-2, AC-3, AC-4, AC-5/);

  const optOutDuringRun = item('GY-99');
  optOutDuringRun.decomposition = { state: 'running', startedAt: new Date(NOW).toISOString(), endedAt: null, runtime: 'pi', model: 'm', timeoutMs: 60_000, bounds: ['b'], reason: null, children: [], failure: null, recordedBy: 'x' };
  optOutDuringRun.split = false;
  assert.throws(() => applyDecompositionEvent(optOutDuringRun, { event: 'decided', payload: proposal }, 'graphyard-master', new Date(NOW)), /opted out of splitting while it was being split/);

  const refused = item('GY-21'), failed = item('GY-22'), kept = item('GY-23');
  const items = [refused, failed, kept];
  const { runner } = fakeRunner(prompt => prompt.includes('GY-21') ? submitted({ reason: 'r', children: [base[0], base[1]] })
    : prompt.includes('GY-22') ? { ok: false, failure: { reason: 'timeout', detail: 'the run took too long' }, payloads: [] }
    : submitted({ reason: 'The criteria share one function; split, they would conflict.', children: [] }));
  const { events, record } = plane(items);
  await step(items, runner, record);
  await decompositionSettled();
  assert.deepEqual(events.map(entry => `${entry.key}:${entry.event.event}`), ['GY-21:started', 'GY-22:started', 'GY-23:started', 'GY-21:decided', 'GY-21:failed', 'GY-22:failed', 'GY-23:decided']);
  assert.deepEqual(items.slice(0, 3).map(entry => entry.decomposition?.state), ['failed', 'failed', 'kept']);
  assert.match(refused.decomposition!.failure!.detail, /refused the proposed split: .*drops AC-5/);
  for (const entry of [refused, failed, kept]) {
    assert.equal(entry.children, undefined); assert.equal(entry.criteria.length, 5, `${entry.key}'s criteria are untouched`);
    assert.equal(dispatchable(entry, items), null, `${entry.key} is dispatched whole`);
    assert.equal(decompositionWanted(entry, settings), null, `${entry.key} is not put to decomposition again`);
  }
});

// ---- Through the control plane: the split, the relation and the parent's delivery -------------

const repository = 'owner/project';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1126;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('item-split'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('item_split_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/item_split_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });

async function request(principal: Principal, path: string, body: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const reload = async (key: string) => (await store.list()).find(entry => entry.key === key)!;
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');

/** Build and merge a child the way a worker's pull request lands inside a direct-merge window. */
async function deliver(key: string, mergedAt: string) {
  let w = await reload(key);
  w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/item-split-${key}`, branch: `graphyard/${key.toLowerCase()}-1` }, randomUUID());
  const pr = 900 + Number(key.slice(3));
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr }, randomUUID());
  const observation: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: sha(key), baseSha: 'b'.repeat(40), pr, branch: w.workspaces[0].branch, author: 'implementer' },
    checks: [], reviews: [], protected: true, mergeable: false, merged: true, prState: 'closed', mergeSha: sha(`merge-${key}`), mergedAt, baseTip: sha(`merge-${key}`), baseTree: '7e'.repeat(20), files: [], scopeFiles: [], at: new Date().toISOString() };
  return engine.observe(w.id, (await reload(key)).revision, observation);
}

test('unit:broad-items-split-before-dispatch — the control plane makes the split in one transaction with numbered children, owns the relation, takes the opt-out by requirements revision, and delivers the parent with a ledger event when its last child is delivered; master status shows the relation', async () => {
  const created = await engine.execute(operator, 'create', null, { title: 'Broad item', criteria: criteria.slice(0, 3), plannedFiles: ['src/', 'tests/', 'docs/'] }, randomUUID());
  // The relation is the server's to set: an item cannot be created naming children or a parent.
  for (const field of [{ children: [created.key] }, { parent: created.key }]) assert.equal((await request(operator, 'work', { title: 'Forged', criteria: criteria.slice(0, 1), ...field })).status, 400);
  await engine.execute(operator, 'ready', created.id, {}, randomUUID());
  // Only the coordinator (or an admin) records a decomposition.
  assert.equal((await request(worker, `work/${created.key}/decomposition`, { event: 'started', runtime: 'pi', model: 'm', timeoutMs: 60_000, bounds: ['3 root-level planned directories'] })).status, 403);
  const started = await request(coordinator, `work/${created.key}/decomposition`, { event: 'started', runtime: 'pi', model: 'm', timeoutMs: 60_000, bounds: ['3 root-level planned directories'] });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const payload = { reason: 'Two halves', children: [
    { title: 'First half', criteria: ['AC-1', 'AC-2'], plannedFiles: ['src/decomposition.ts', 'tests/item-split.test.ts'] },
    { title: 'Second half', criteria: ['AC-3'], plannedFiles: ['docs/coordination.md'], after: [0] },
  ] };
  assert.equal((await request(coordinator, `work/${created.key}/decomposition`, { event: 'decided', payload: { ...payload, children: [payload.children[0]] } })).status, 400, 'a one-child split is refused');
  const split = await request(coordinator, `work/${created.key}/decomposition`, { event: 'decided', payload });
  assert.equal(split.status, 200, JSON.stringify(split.body));
  const parent = await reload(created.key);
  assert.equal(parent.children?.length, 2);
  const [first, second] = await Promise.all(parent.children!.map(reload));
  assert.match(first.key, /^GY-\d+$/); assert.match(second.key, /^GY-\d+$/);
  assert.deepEqual([first.parent, second.parent], [parent.key, parent.key]);
  assert.deepEqual([...first.criteria, ...second.criteria].map(criterion => [criterion.id, criterion.text, criterion.proofs]), parent.criteria.map(criterion => [criterion.id, criterion.text, criterion.proofs]));
  assert.deepEqual(second.dependencies, [first.id]);
  assert.equal(first.ready, true);
  const ledger = async (id: string, kind: string) => (await store.pool.query('SELECT actor, payload FROM events WHERE work_id=$1 AND kind=$2', [id, kind])).rows;
  assert.equal((await ledger(parent.id, 'decomposition.split')).length, 1);
  assert.equal((await ledger(first.id, 'decomposition.child-created')).length, 1);
  assert.equal((await request(coordinator, `work/${created.key}/decomposition`, { event: 'started', runtime: 'pi', model: 'm', timeoutMs: 60_000, bounds: ['again'] })).status, 409, 'one run per item');
  assert.equal((await request(worker, `work/${parent.key}/claim`, {})).status, 409, 'a split parent cannot be claimed directly');
  assert.equal((await request(operator, `work/${parent.key}/requirements`, { expectedPolicyRevision: 1, reason: 'r', criteria: parent.criteria, dependencies: [], plannedFiles: ['src/'], exclusiveResources: [] })).status, 409, 'requirements revision on a split parent is refused');

  // A child keeps the criteria it inherited unchanged, or the parent would never be delivered; it may add its own.
  const childRevision = (childCriteria: typeof criteria) => request(operator, `work/${first.key}/requirements`, { expectedPolicyRevision: first.policyRevision, reason: 'r', criteria: childCriteria, dependencies: first.dependencies, plannedFiles: first.plannedFiles, exclusiveResources: [] });
  const reworded = await childRevision([{ ...first.criteria[0], text: 'Reworded.' }, first.criteria[1]]);
  assert.equal(reworded.status, 409, 'rewriting an inherited criterion on a child is refused');
  assert.match(JSON.stringify(reworded.body), /AC-1 of its split parent/);
  assert.equal((await childRevision([first.criteria[0]])).status, 409, 'retiring an inherited criterion on a child is refused');
  const added = await childRevision([...first.criteria, { id: 'AC-9', text: 'An added behaviour holds.', proofs: ['unit:behaviour-9'] }]);
  assert.equal(added.status, 200, JSON.stringify(added.body));

  // The operator's opt-out is a requirements field on an existing item.
  const other = await engine.execute(operator, 'create', null, { title: 'Opt out later', criteria: criteria.slice(0, 2), plannedFiles: ['src/'] }, randomUUID());
  const revised = await request(operator, `work/${other.key}/requirements`, { expectedPolicyRevision: 1, reason: 'Keep it whole', criteria: other.criteria, dependencies: [], plannedFiles: ['src/'], exclusiveResources: [], split: false });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal((await reload(other.key)).split, false);

  // Delivery: the parent stays open until its last child is delivered, then is delivered with it.
  const on = await request(operator, 'direct-merges/on', { since: '2026-01-01T00:00:00Z', reason: 'The suite merges children straight into main' });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  await deliver(first.key, '2026-02-01T10:00:00Z');
  assert.notEqual((await reload(parent.key)).stage, 'done', 'one child delivered is not the parent delivered');
  let status = buildMasterStatus({ work: await store.list(), now: new Date().toISOString() }, [], []);
  const row = status.work.find(entry => entry.key === parent.key)!;
  assert.deepEqual(row.split?.children, [first.key, second.key]);
  assert.equal(status.work.find(entry => entry.key === second.key)!.split?.parent, parent.key);
  assert.deepEqual(status.splits.find(entry => entry.key === parent.key)!.children.map(child => [child.key, child.delivered]), [[first.key, true], [second.key, false]]);

  await deliver(second.key, '2026-02-01T11:00:00Z');
  const delivered = await reload(parent.key);
  assert.equal(delivered.stage, 'done');
  assert.equal(delivered.delivery?.mergeSha, sha(`merge-${second.key}`), 'its merge is the last child\'s');
  assert.deepEqual(delivered.delivery?.children?.map(child => child.key), [first.key, second.key]);
  const recorded = await ledger(parent.id, 'decomposition.parent-delivered');
  assert.equal(recorded.length, 1); assert.equal(recorded[0].actor, 'graphyard');
  status = buildMasterStatus({ work: await store.list(), now: new Date().toISOString() }, [], []);
  assert.equal(status.splits.find(entry => entry.key === parent.key)!.delivered, true);
  assert.equal(splitParentDelivery(await reload(second.key), await store.list(), new Date()), null, 'a delivered parent is delivered once');
});

// ---- The real loop: the step runs in cycle step 4, before dispatch ----------------------------

test('unit:broad-items-split-before-dispatch — across loop cycles the broad item is held while it is split and never dispatched, its children are dispatched in order, and the item within the bounds is dispatched at once', async t => {
  t.after(clearDecompositionRuns);
  const directory = await temporaryDirectory('item-split-loop');
  const credential = join(directory, 'token'); await writeFile(credential, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const profile = (name: string) => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch' as const, kind: 'codex' as const, credentialFile: credential, agentArgs: [], approvals: 'auto' as const, environment: {} });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: credential, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), repository: 'owner/project',
    baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: ['one', 'two', 'three'].map(profile), run: { research: {} } });
  const broad = item('GY-30', { stageEnteredAt: new Date(NOW - 60_000).toISOString() }), small = item('GY-31', { criteria: criteria.slice(0, 1), plannedFiles: ['src/coordination.ts'] });
  const items = [broad, small];
  const { runner, starts } = fakeRunner(() => submitted(proposal));
  const { record } = plane(items);
  const log: string[] = [];
  const effects: DaemonEffects = {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: structuredClone(items), now: new Date(NOW).toISOString() }),
    closeSession: () => {}, dispatch: async item => { log.push(item.key); }, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(NOW).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    research: { cwd: process.cwd(), runner }, recordDecomposition: record,
  };
  try {
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => NOW);
    assert.deepEqual(log, ['GY-31'], 'the broad item waits while its run is in progress; the small one is dispatched');
    assert.equal(starts.length, 1);
    await decompositionSettled();
    log.length = 0;
    await runCycle(master, state, effects, () => NOW + 60_000);
    assert.ok(log.includes('GY-101'), `the first child is dispatched: ${log.join(', ')}`);
    assert.ok(!log.includes('GY-30') && !log.includes('GY-102') && !log.includes('GY-103'), `the parent is never dispatched and later children wait for the first: ${log.join(', ')}`);
    assert.equal(starts.length, 1, 'no second session');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
