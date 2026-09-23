import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { leaseLossReason, standingEscalations, type Escalation, type Principal, type Work } from '../src/model.js';
import { actionIdleMs, idleActionable, queueSnapshot, reconcileActions } from '../src/model/actions.js';
import { actionJudgment, executorRunnableKinds, humanNeeded, humanNeededActions, nextAction, openAction } from '../src/model/next-action.js';
import { runExecutorTick, type ExecutorEffects } from '../src/auto-dispatch.js';
import { controlPlaneHandlers } from '../src/executor.js';
import { masterConfigSchema } from '../src/master.js';
import { humanNeededAttention, needsHumanActions, scopeRequestAttention } from '../src/cli/master-status.js';

/**
 * GY-104: an item stops only for a judgement it actually needs.
 *
 * A standing escalation used to be answered before anything else was considered, so a concern
 * that blocked nothing still froze work anybody could have done; an escalation whose cause the
 * ledger already explained still waited for a person; and a scope widening an item's own criteria
 * imply waited for a master session to run a command. Each test here is named for the proof it
 * produces: integration:escalation-does-not-freeze-workable-item,
 * integration:explained-escalations-settle-unattended,
 * integration:scope-request-answered-by-executor and unit:human-needed-actions-visible.
 *
 * No test here runs a master session. Where an action has to be carried out, it is carried out by
 * the shipped executor handlers (`src/executor.ts`) over stubbed launchers, exactly as a host
 * running `graphyard executor` would.
 */

const human: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const master: Principal = { id: 'master-admin', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'engineer-a', role: 'worker', runtime: 'claude', sessionKind: 'ai' };
const other: Principal = { id: 'engineer-b', role: 'worker', runtime: 'cursor', sessionKind: 'ai' };
const executor: Principal = { id: 'executor-a', role: 'coordinator' };
const PROOF = 'unit:priority';

let database: EmbeddedPostgres, store: Store, engine: Engine, expiring: Engine;
let http: ReturnType<typeof server>, url: string;
const executorToken = 'x'.repeat(32);

const id = () => randomUUID();
const reload = async (work: Work | string) => (await store.list()).find(item => item.id === (typeof work === 'string' ? work : work.id))!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind);
const rows = (work: Work) => work.actionQueue?.actions ?? [];
/** The computed action, untyped at the call site so one assertion cannot narrow the next. */
const action = (work: Work): any => openAction(work);

before(async () => {
  // An offset no other test file takes: two files that share a port fail whichever starts its
  // Postgres second, in its `before` hook, with no reason given.
  const port = Number(process.env.GRAPHYARD_ACTION_PRIORITY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 94);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-action-priority-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [human, master, worker, other, executor];
  // Leases granted by this engine have already lapsed by the time reconciliation reads them.
  expiring = new Engine(store, [15368], 0, 'owner/project'); expiring.principals = engine.principals;
  http = server(engine, [{ ...executor, token: executorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

/**
 * Every item this file creates owns a planned scope of its own. Planned-file overlap holds a
 * dispatch whatever else is true of an item, so an item that shares a scope with another would
 * not be dispatchable for a reason that has nothing to do with the escalation under test.
 */
let sequence = 0;
async function created(overrides: Record<string, unknown> = {}) {
  const scope = `src/priority-${++sequence}/`;
  return engine.execute(human, 'create', null, { title: `Priority ${sequence}`, plannedFiles: [scope], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }], ...overrides }, id());
}
const release = (work: Work) => engine.execute(human, 'ready', work.id, {}, id());
const ready = async (overrides: Record<string, unknown> = {}) => release(await created(overrides));

/** Rewrite the stored document the way an earlier cycle left it, without a command to do it with. */
async function overwrite(work: Work, mutate: (document: Work) => void) {
  const document = await reload(work); mutate(document);
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [document.id, JSON.stringify(document)]);
  return document;
}
const lapse = (work: Work, epoch: number, owner = worker.id) =>
  overwrite(work, document => { document.lease = { owner, epoch, expiresAt: '2000-01-01T00:00:00Z' }; });
/** The record as it stands when the control plane has raised a lease-loss and nothing has settled it. */
async function standingLoss(work: Work, epoch: number, owner = worker.id) {
  return overwrite(work, document => {
    const escalation: Escalation = { trigger: 'lease-loss', reason: leaseLossReason({ owner, epoch }), at: new Date().toISOString(), actor: 'graphyard' };
    document.escalations = [escalation]; document.escalation = escalation; document.mergeAuthorization = null; document.lease = null;
    const gate = document.gates.find(entry => entry.name === 'merge')!;
    gate.passed = false; gate.reasons.push(`Unresolved lease-loss escalation requires operator resolution: ${escalation.reason}`);
  });
}

const config = masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: '/outside/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 15368, hostId: 'host-1', masterAgentName: 'm',
  workers: [{ name: 'claude-worker', principal: other.id, agentName: 'work-claude', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' }],
});

/**
 * One stateless executor running the handlers Graphyard ships. What is stubbed is the outside
 * world each handler reaches — here, the worker launcher — and the stub does what that session
 * really does to the control plane: it claims under its own identity and registers its workspace.
 */
function fleetExecutor(launched: string[], only?: string): ExecutorEffects {
  const handlers = controlPlaneHandlers(() => config, {
    snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
    mutate: async (path, body) => {
      const [, item, command] = path.split('/');
      return engine.execute(executor, command as any, item, body, id());
    },
    agents: () => [],
    workerCredentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    producerCredentials: async () => ({}),
    dispatchWorker: async item => {
      let claimed = await engine.execute(other, 'claim', item.id, {}, id());
      claimed = await engine.execute(other, 'workspace', claimed.id, { epoch: claimed.epoch, host: 'host-1', path: `/tmp/priority/${claimed.id}-${claimed.epoch}`, branch: `graphyard/${claimed.key.toLowerCase()}-${claimed.epoch}` }, id());
      launched.push(claimed.key);
      return { pane: 'pane-w' };
    },
    launchReview: async () => { throw new Error('no review is launched here'); },
    launchProducer: async () => { throw new Error('no producer is launched here'); },
    merge: async () => { throw new Error('no merge is brokered here'); },
    observeDeployment: async () => { throw new Error('no deployment is observed here'); },
  });
  return {
    // Scoped to the item under test, the way a real executor is scoped to its repository: the
    // control plane still decides what the row is and still settles the race between executors.
    claim: request => engine.claimNextAction(executor, { ...request, ...(only ? { work: only } : {}) }, id()) as ReturnType<ExecutorEffects['claim']>,
    settle: (row, result, reason) => engine.settleClaimedAction(executor, row.id, { result, reason, ...(row.claim?.executor ? { executor: row.claim.executor } : {}) }, id()),
    handlers,
  };
}
const runExecutor = (effects: ExecutorEffects) => runExecutorTick({ id: executor.id, host: 'host-1' }, effects);

// ---- AC-1: an escalation stops only the work it blocks -----------------------------------------

test('integration:escalation-does-not-freeze-workable-item — a ready item carrying a standing lease-loss escalation is named dispatch, an executor assigns a worker to it, and the escalation stands unresolved beside the work', async () => {
  // A worker claims and vanishes: reconciliation clears the lapse and raises the concern nobody
  // has explained, exactly as it does in production.
  let item = await ready();
  item = await expiring.execute(worker, 'claim', item.id, {}, id());
  const epoch = item.epoch;
  await engine.reconcile();
  item = await reload(item);
  assert.equal(item.lease, null, 'the lapsed lease is cleared');
  assert.deepEqual(standingEscalations(item).map(entry => [entry.trigger, entry.actor]), [['lease-loss', 'graphyard']], 'nothing explains the lapse, so the concern stands');
  assert.match(item.gates.find(gate => gate.name === 'merge')!.reasons.join(' '), /Unresolved lease-loss escalation/, 'and it still refuses delivery');

  // The item is otherwise dispatchable, so that is what it is named — the escalation blocks
  // delivery and nothing earlier, and it is carried beside the work rather than in front of it.
  assert.equal(action(item).kind, 'dispatch');
  assert.equal(action(item).inputs.target, 'implementation');
  assert.equal(action(item).llmRole, 'implement');
  assert.deepEqual(action(item).carried.map((concern: any) => [concern.kind, concern.trigger, concern.reason]),
    [['escalation', 'lease-loss', `Worker ${worker.id} lost lease epoch ${epoch}`]]);
  assert.match(action(item).carried[0].resolve, new RegExp(`graphyard master escalation ${item.key} lease-loss`));
  assert.equal(action(item).needsHuman, undefined, 'a dispatch is not itself a judgment anybody owes');
  assert.deepEqual(rows(item).map(row => row.kind), ['dispatch'], 'and the durable row an executor claims is the dispatch');

  // The concern is not lost behind the work: it is listed as owed by somebody, with the command.
  const owed = humanNeededActions([item], new Date());
  assert.deepEqual(owed.map(entry => [entry.key, entry.source, entry.trigger]), [[item.key, 'carried', 'lease-loss']]);
  assert.match(humanNeededAttention({ work: [item], now: new Date().toISOString() })[0].text, /standing lease-loss escalation while it is worked/);

  // An executor claims the row and the shipped dispatch handler launches a worker, which claims
  // the item under its own identity. Nobody resolved anything first.
  const launched: string[] = [];
  const step = await runExecutor(fleetExecutor(launched, item.id));
  assert.equal(step.result, 'done', step.reason);
  assert.deepEqual(launched, [item.key]);
  item = await reload(item);
  assert.equal(item.lease!.owner, other.id, 'a worker holds the item');
  assert.equal(item.lease!.epoch, epoch + 1, 'under a fresh attempt');
  assert.deepEqual(standingEscalations(item).map(entry => entry.trigger), ['lease-loss'], 'assigned without the escalation being resolved first');
  assert.equal(action(item).kind, 'escalate', 'and with the work under way, the concern is what is left to do');
  assert.equal(action(item).needsHuman.decision, `resolving ${item.key}'s lease-loss escalation`);

  // The half the escalation does block is unchanged: nothing may be delivered under one, and an
  // item that cannot take an assignment anyway is still named for the concern rather than for a
  // dispatch no executor could complete.
  const blocked = await ready();
  const holder = await engine.execute(worker, 'claim', (await ready({ plannedFiles: blocked.plannedFiles })).id, {}, id());
  const stood = await standingLoss(blocked, 1);
  await engine.reconcile();
  const held = await reload(stood);
  assert.equal(action(held).kind, 'escalate');
  assert.match(action(held).reason, new RegExp(`no assignment it can take \\(its planned files overlap ${holder.key} \\(claimed\\)`));
  assert.equal(action(held).needsHuman.decision, `resolving ${held.key}'s lease-loss escalation`);
});

// ---- AC-2: an escalation the ledger explains settles without anybody deciding it ---------------

test('integration:explained-escalations-settle-unattended — a lease-loss the ledger explains (a recorded operator shutdown, a stopped-worker attestation, a capacity exhaustion) is settled by reconciliation with an audited note, and only a lapse nothing explains reaches a person', async () => {
  // 1. A recorded operator shutdown: the worker reported blocked for its epoch and stopped
  //    awaiting the operator. The escalation the control plane raised for that lapse rests on an
  //    attempt whose end the ledger already accounts for.
  let shutdown = await engine.execute(worker, 'claim', (await ready()).id, {}, id());
  const shutdownEpoch = shutdown.epoch;
  shutdown = await engine.execute(worker, 'blocked', shutdown.id, { epoch: shutdownEpoch, reason: 'The operator stopped every session to clear a wedged shell' }, id());
  await standingLoss(shutdown, shutdownEpoch);
  await engine.reconcile();
  shutdown = await reload(shutdown);
  assert.deepEqual(standingEscalations(shutdown), [], 'the blocked report for that epoch settles it');
  const shutdownNote = (await events(shutdown, 'escalation.auto-settled')).at(-1)!;
  assert.equal(shutdownNote.actor, 'graphyard');
  assert.equal(shutdownNote.payload.details.cause, 'blocked-awaiting-operator');
  assert.match(shutdownNote.payload.details.note, new RegExp(`^auto-settled: blocked report for epoch ${shutdownEpoch} explains the lapse`));

  // 2. A stopped-worker attestation recorded after the concern was raised: the admin says the
  //    worker was stopped, and the next cycle settles what that explains.
  let stopped = await engine.execute(worker, 'claim', (await ready()).id, {}, id());
  const stoppedEpoch = stopped.epoch;
  await lapse(stopped, stoppedEpoch);
  await engine.reconcile();
  stopped = await reload(stopped);
  assert.deepEqual(standingEscalations(stopped).map(entry => entry.trigger), ['lease-loss'], 'a silent lapse escalates first');
  await engine.execute(master, 'rework', stopped.id, { reason: 'I stopped that session myself before re-dispatching', previousWorkerStopped: true }, id());
  await engine.reconcile();
  stopped = await reload(stopped);
  assert.deepEqual(standingEscalations(stopped), [], 'and the attestation settles it on the next pass');
  assert.equal((await events(stopped, 'escalation.auto-settled')).at(-1)!.payload.details.cause, 'stopped-by-attestation');

  // 3. A capacity exhaustion: the loop reads the spent account out of the session's own output
  //    after the lease has already lapsed and been reconciled. The attempt did not vanish — the
  //    control plane recorded why it ended — so nothing is left for a person to judge.
  let spent = await engine.execute(worker, 'claim', (await ready()).id, {}, id());
  const spentEpoch = spent.epoch;
  await lapse(spent, spentEpoch);
  await engine.reconcile();
  spent = await reload(spent);
  assert.deepEqual(standingEscalations(spent).map(entry => entry.trigger), ['lease-loss']);
  const reported = await fetch(`${url}/api/work/${spent.id}/capacity`, {
    method: 'POST', headers: { Authorization: `Bearer ${executorToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() },
    body: JSON.stringify({ event: 'exhausted', role: 'worker', epoch: spentEpoch, profile: 'claude-worker', account: 'claude-two', runtime: 'claude', reason: 'Claude AI usage limit reached', resetsAt: '2026-09-22T04:00:00.000Z', partialWork: { state: 'clean' } }),
  });
  assert.equal(reported.status, 200, JSON.stringify(await reported.clone().json()));
  await engine.reconcile();
  spent = await reload(spent);
  assert.deepEqual(standingEscalations(spent), [], 'the exhaustion record explains the lapse');
  const spentNote = (await events(spent, 'escalation.auto-settled')).at(-1)!;
  assert.equal(spentNote.payload.details.cause, 'exhausted-capacity');
  assert.match(spentNote.payload.details.note, /the claude-worker account claude-two reported no quota left for epoch/);
  assert.match(spentNote.payload.details.note, /resets 2026-09-22T04:00:00.000Z/);
  assert.equal(humanNeededActions([spent], new Date()).length, 0, 'and nothing about it is owed to anybody');

  // A lapse the ledger explains raises nothing in the first place, and every settlement above
  // happened with no session of any kind: reconciliation is the whole mechanism.
  let explained = await engine.execute(worker, 'claim', (await ready()).id, {}, id());
  const explainedEpoch = explained.epoch;
  await engine.execute(worker, 'blocked', explained.id, { epoch: explainedEpoch, reason: 'Waiting on the operator' }, id());
  await lapse(explained, explainedEpoch);
  await engine.reconcile();
  explained = await reload(explained);
  assert.deepEqual(standingEscalations(explained), []);
  assert.equal((await events(explained, 'lease.expired')).at(-1)!.payload.details.cause, 'blocked-awaiting-operator');

  // Only a lapse nothing explains is a judgement: it stands, it refuses delivery, and it is
  // listed as owed to a person with the command that answers it.
  let vanished = await engine.execute(worker, 'claim', (await ready()).id, {}, id());
  await lapse(vanished, vanished.epoch);
  await engine.reconcile();
  vanished = await reload(vanished);
  assert.deepEqual(standingEscalations(vanished).map(entry => entry.trigger), ['lease-loss']);
  await engine.reconcile();
  assert.deepEqual(standingEscalations(await reload(vanished)).map(entry => entry.trigger), ['lease-loss'], 'and no later pass settles what nothing explains');
  assert.equal(humanNeededActions([await reload(vanished)], new Date()).length, 1);
  await assert.rejects(engine.execute(master, 'resolve', (await reload(vanished)).id, { trigger: 'lease-loss', reason: 'Automation says it is fine', expectedRevision: (await reload(vanished)).revision }, id()),
    /requires a declared human session/);
});

// ---- AC-3: a scope request the criteria imply is answered by an executor ------------------------

test('integration:scope-request-answered-by-executor — a request for a file an acceptance criterion names is granted by the approve-scope action an executor completes, with no master session, and only a widening the criteria do not support reaches a person', async () => {
  const target = 'src/priority-palette/tokens.ts';
  let item = await release(await created({ criteria: [
    { id: 'AC-1', text: 'The widget renders its palette', proofs: [PROOF] },
    { id: 'AC-2', text: `${target} holds the palette tokens the widget reads`, proofs: [PROOF] },
  ] }));
  item = await engine.execute(worker, 'claim', item.id, {}, id());
  const epoch = item.epoch;
  item = await engine.execute(worker, 'workspace', item.id, { epoch, host: 'host-1', path: `/tmp/priority/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${epoch}` }, id());
  const planned = [...item.plannedFiles];

  // The worker keeps its lease and records what it needs; the control plane names the step.
  item = await engine.execute(worker, 'scope', item.id, { epoch, paths: [target], reason: 'AC-2 puts the tokens there' }, id());
  assert.equal(action(item).kind, 'approve-scope');
  assert.deepEqual(action(item).inputs, { kind: 'approve-scope', epoch, paths: [target], requestedBy: worker.id, detail: 'AC-2 puts the tokens there' });
  assert.equal(action(item).llmRole, null, 'applying the item\'s own scope is mechanical');
  assert.equal(action(item).needsHuman, undefined);
  assert.ok(executorRunnableKinds.includes('approve-scope'), 'and it is a kind an executor may claim');
  // Nobody is asked to decide it: the attention list is for widenings the item does not carry.
  assert.deepEqual(scopeRequestAttention({ work: [item], now: new Date().toISOString() }), []);

  const step = await runExecutor(fleetExecutor([], item.id));
  assert.equal(step.result, 'done', step.reason);
  assert.match(step.reason!, /the widening rule decided .*approved/);
  item = await reload(item);
  assert.deepEqual(item.plannedFiles, [...planned, target], 'the widening is applied');
  assert.equal(item.scopeRequest, null, 'the request is answered and cleared');
  assert.equal(item.scopeDecision!.decidedBy, 'graphyard');
  assert.match(item.scopeDecision!.reason, new RegExp(`${target.replace(/\./g, '\\.')} \\(AC-2 names ${target.replace(/\./g, '\\.')}\\)`));
  assert.equal(item.lease!.epoch, epoch, 'and the attempt keeps its lease');
  assert.equal(action(item), null, 'and the item needs nothing from anybody: the worker holding it is doing the work');

  // A widening no criterion implies is the one that is somebody's decision: the loop refuses it,
  // the item is blocked on the refusal, and it is named for a person with the command.
  const outside = 'src/priority-unclaimed/other.ts';
  item = await engine.execute(worker, 'scope', item.id, { epoch, paths: [outside], reason: 'It looked related' }, id());
  const refused = await runExecutor(fleetExecutor([], item.id));
  assert.equal(refused.result, 'done', refused.reason);
  assert.match(refused.reason!, /refused/);
  item = await reload(item);
  assert.deepEqual(item.plannedFiles, [...planned, target], 'nothing was widened');
  assert.match(item.blocker!, /^Scope request refused/);
  const attention = scopeRequestAttention({ work: [item], now: new Date().toISOString() });
  assert.equal(attention.length, 1);
  assert.match(attention[0].text, /The widening rule refuses it:/);
  assert.equal(attention[0].next, `graphyard master scope ${item.key}`);
  assert.equal(action(item).kind, 'escalate', 'and the item itself says a judgment is owed');
  assert.ok(humanNeededActions([item], new Date()).some(entry => entry.key === item.key && entry.source === 'action'));

  // The worker withdraws the ask; the refusal it earned goes with it and the item works on.
  item = await engine.execute(worker, 'scope', item.id, { epoch, paths: [], reason: 'Withdrawn' }, id());
  assert.equal(item.blocker, null);
  assert.deepEqual(scopeRequestAttention({ work: [item], now: new Date().toISOString() }), []);
});

// ---- AC-4: an action no executor may run is owed by somebody, and counted apart -----------------

const at = '2026-09-21T12:00:00.000Z';
const probe = (overrides: Partial<Work> = {}): Work => ({
  id: `id-${overrides.key ?? 'GY-1'}`, key: 'GY-1', title: 'Owed', type: 'feature', description: '',
  priority: 2, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [],
  ready: true, stage: 'merge', epoch: 1, revision: 1, policyRevision: 1,
  gates: [], violations: [], evidence: [], workspaces: [], agentRequests: [], sessions: [],
  lease: null, submission: null, candidate: null, observation: null, blocker: null,
  escalation: null, escalations: [], createdAt: at, updatedAt: at, stageEnteredAt: at,
  ...overrides,
} as unknown as Work);

test('unit:human-needed-actions-visible — an item whose only action is escalate is recorded as needing a person, listed on the human-facing page from the moment it is computed, and counted apart from the rows executors are taking', () => {
  const now = new Date(Date.parse(at) + 30_000);
  // The one refusal no executor step answers: branch protection nobody has verified.
  const refusal = 'Required Graphyard check and merge-queue branch protection have not been verified';
  const owedItem = probe({ gates: [{ name: 'merge', passed: false, reasons: [refusal] }] } as Partial<Work>);
  const computed = nextAction(owedItem, [owedItem], new Date(at))!;
  assert.equal(computed.kind, 'escalate');
  assert.equal(actionJudgment.escalate, 'in-step');
  assert.ok(!executorRunnableKinds.includes('escalate'), 'no executor may hold a handler for it, so no executor will ever claim the row');
  assert.deepEqual(computed.needsHuman, { decision: `resolving ${owedItem.key}'s merge refusal`, resolve: `graphyard diagnose ${owedItem.key} — ${refusal}` });
  assert.deepEqual(humanNeeded(computed), computed.needsHuman, 'what the action records is what the rule says');

  // Beside it, a row an executor is simply yet to take.
  const queuedItem = probe({ key: 'GY-2', id: 'id-GY-2', gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }] } as Partial<Work>);
  assert.equal(nextAction(queuedItem, [queuedItem], new Date(at))!.kind, 'dispatch');
  const work = [owedItem, queuedItem];
  for (const item of work) {
    item.nextAction = nextAction(item, work, new Date(at));
    reconcileActions(item, work, new Date(at), { next: item.nextAction });
  }

  // Visible as needing a person straight away: the wait is measured from the moment the control
  // plane computed the action, not from the moment the row grew old enough for the idle list.
  const owed = humanNeededActions(work, now);
  assert.deepEqual(owed.map(entry => [entry.key, entry.source, entry.kind]), [[owedItem.key, 'action', 'escalate']]);
  assert.equal(owed[0].action, rows(owedItem)[0].id, 'the row it belongs to is named');
  assert.equal(owed[0].since, at);
  assert.equal(owed[0].waitedMs, 30_000);
  assert.ok(owed[0].waitedMs < actionIdleMs, 'inside the idle bound, where nothing else would have reported it');
  assert.equal(idleActionable(work, now).length, 0, 'the queue itself calls nothing idle yet');

  // The human-facing page names it, with the command that answers it and who answers it.
  const page = humanNeededAttention({ work, now: now.toISOString() });
  assert.deepEqual(page.map(entry => [entry.subject, entry.role, entry.approvedBy]), [[owedItem.key, 'master', 'approver']]);
  assert.match(page[0].text, /no executor may run it/);
  assert.equal(page[0].next, `graphyard diagnose ${owedItem.key} — ${refusal}`, 'and the command that reads out what it is waiting on');

  // Counted apart from work that is merely queued: the two rows are both unclaimed, and only one
  // of them is waiting for an executor.
  const queue = queueSnapshot(work, now);
  assert.deepEqual(queue.waiting.map(row => row.kind).sort(), ['dispatch', 'escalate']);
  const report = needsHumanActions({ ...queue, idle: idleActionable(work, new Date(now.getTime() + actionIdleMs + 1000)) }, owed);
  assert.deepEqual(report.needsHuman, owed);
  assert.deepEqual(report.waiting.map(row => row.kind), ['dispatch'], 'the queue executors read holds only what they can take');
  assert.deepEqual(report.idle.map(row => row.kind), ['dispatch'], 'and a row nobody may claim never ages into the idle list');

  // A standing escalation beside a running action is owed just the same: the work is not frozen
  // by it, and it is not lost behind the work.
  const escalation: Escalation = { trigger: 'security-concern', reason: 'A credential appears in the diff', at, actor: human.id };
  const carrying = probe({ key: 'GY-3', id: 'id-GY-3', escalation, escalations: [escalation],
    gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }] } as Partial<Work>);
  carrying.nextAction = nextAction(carrying, [carrying], new Date(at));
  assert.equal(carrying.nextAction!.kind, 'dispatch');
  const both = humanNeededActions([carrying], now);
  assert.deepEqual(both.map(entry => [entry.source, entry.trigger, entry.waitedMs]), [['carried', 'security-concern', 30_000]]);
  assert.match(both[0].resolve, /graphyard master escalation GY-3 security-concern/);
});
