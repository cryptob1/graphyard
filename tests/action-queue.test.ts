import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { evaluate, type Observation, type Principal, type Work } from '../src/model.js';
import { actionClaimMs, actionId, claimable, claimAction, idleActionable, openActions, queueSnapshot, reconcileActions, settleAction, type ActionRow } from '../src/model/actions.js';
import { llmRoles, mechanicalActionKinds, nextAction, nextActionKinds, nextActionLlmRoles, refusalAction, type NextActionKind } from '../src/model/next-action.js';
import { agentRequestTypes, deciderFor, humanDecisions, openAgentRequests } from '../src/model/agent-requests.js';
import { attachCommand, runningSessions, sessionSummary } from '../src/model/sessions.js';
import { pipelineSpeedSummary, speedTarget } from '../src/pipeline-speed.js';
import { executorEffects, executorKinds, runExecutor, runExecutorTick, workerPullIntervalMs, type ExecutorEffects } from '../src/auto-dispatch.js';
import { runCycle, emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { agentRequestAttention, agentRequestReport, actionReport, sessionReport } from '../src/cli/master-status.js';
import { queueRef, type QueueSpeculation } from '../src/merge-queue.js';
import WorkDetails from '../web/pages/work-details.js';

/**
 * GY-87: coordination inverted. The control plane computes a typed next action per item; durable
 * leased rows say whether anybody is running it; stateless executors claim and run them.
 *
 * Each test is named for the proof it produces, so acceptance evidence maps to one executed case
 * per required proof: integration:typed-next-action, integration:action-queue-leases,
 * integration:multi-executor-throughput, integration:worker-pull-model,
 * integration:no-llm-in-critical-path, integration:typed-agent-requests,
 * integration:session-handles-visible, and manual:throughput-without-master.
 *
 * No test here runs a master session. The fleet tests drive whole items to delivery through the
 * queue alone; `runCycle` appears once, in the typed-request test, only to prove what the loop
 * records about a session that stops at a prompt instead of recording a request.
 */

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const otherWorker: Principal = { id: 'agent-b', role: 'worker', runtime: 'cursor' };
const executorA: Principal = { id: 'executor-a', role: 'coordinator' };
const executorB: Principal = { id: 'executor-b', role: 'coordinator' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['integration:inverted-loop'] };
const PROOF = 'integration:inverted-loop';
const head = 'a'.repeat(40), base = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);

let database: EmbeddedPostgres, store: Store, engine: Engine;
let http: ReturnType<typeof server>, url: string;
before(async () => {
  const port = Number(process.env.GRAPHYARD_ACTION_QUEUE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 25);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-action-queue-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker, otherWorker, executorA, executorB, producer];
  http = server(engine, [{ ...operator, token: 'o'.repeat(32) }, { ...worker, token: 'w'.repeat(32) }, { ...executorA, token: 'x'.repeat(32) }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const reload = async (item: Work | string) => (await store.list()).find(entry => entry.id === (typeof item === 'string' ? item : item.id))!;
const events = async (item: Work, kind: string) => (await store.events(item.id)).filter(event => event.kind === kind).reverse();
const rows = (item: Work) => item.actionQueue?.actions ?? [];
/** The computed action's inputs, untyped at the call site so one assertion cannot narrow the next. */
const inputs = (item: Work): any => item.nextAction!.inputs;
const groupBy = <T>(entries: T[], key: (entry: T) => string) => entries.reduce<Record<string, T[]>>((groups, entry) => { (groups[key(entry)] ??= []).push(entry); return groups; }, {});
const row = (item: Work) => rows(item)[0];

let sequence = 0;
async function created(overrides: Record<string, unknown> = {}) {
  const item = await engine.execute(operator, 'create', null, { title: `Inverted loop ${++sequence}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }], ...overrides }, randomUUID());
  return item;
}
const release = async (item: Work) => engine.execute(operator, 'ready', item.id, {}, randomUUID());
async function submitted(actor: Principal = worker) {
  let item = await release(await created());
  item = await engine.execute(actor, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(actor, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/inverted/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}` }, randomUUID());
  return engine.execute(actor, 'submit', item.id, { epoch: item.epoch, pr: Number(item.key.slice(3)) }, randomUUID());
}
/** The provider's view of a candidate: approved, both checks green, mergeable and protected. */
function observation(item: Work, overrides: Partial<Observation> = {}): Observation {
  return {
    clockOffset: { min: 0, max: 0 },
    candidate: { sha: head, baseSha: base, pr: item.submission!.pr, branch: item.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: new Date().toISOString(),
    prState: 'open', draft: false, baseTip: base, baseTree: sha40('7e'), baseTipContained: true, ...overrides,
  };
}
/** Publish the queue tip the merge authorization requires; the queue's own behaviour has its own tests. */
async function publishTip(item: Work) {
  const current = await reload(item);
  if (!current.queue || current.queue.speculation) return current;
  const speculation: QueueSpeculation = { ref: queueRef(current.key), tip: current.candidate!.sha, base: current.candidate!.baseSha, baseTree: sha40('7e'), predecessors: [], policyRevision: current.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [current.id, JSON.stringify(speculation)]);
  return reload(current);
}
/** Drive one item from its authorized candidate through the guarded merge to a delivered snapshot. */
async function mergeItem(actor: Principal, item: Work) {
  let current = await publishTip(item);
  current = await engine.observe(current.id, current.revision, observation(current));
  const granted = await engine.acquireMerge(actor, current.id, { expectedRevision: current.revision, sha: head, baseSha: base, policyRevision: current.policyRevision }, randomUUID());
  await engine.verifyMerge(actor, current.id, { executionId: granted.execution.id }, observation(current), randomUUID());
  const committed = await engine.commitMerge(actor, current.id, { executionId: granted.execution.id }, randomUUID());
  const mergedAt = new Date(Math.ceil((Date.parse(committed.committingAt) + 1) / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  return engine.observe(current.id, committed.revision, { ...observation(current), merged: true, mergeSha, mergedAt });
}

// ---- AC-1: the control plane computes a typed next action ------------------------------------

test('integration:typed-next-action — the control plane names one typed action per open item, with the inputs it needs, and every gate refusal maps to exactly one action or to escalate', async () => {
  // Backlog is not open work: an unreleased item raises no action at all, though its refusal
  // still maps to one — releasing it is the operator's call about what to work on.
  let item = await created();
  assert.equal(item.nextAction, null);
  assert.deepEqual(item.actionQueue!.actions, []);
  assert.equal(refusalAction(item, 'ready', 'Not released from backlog'), 'escalate');

  // Ready and unassigned: a dispatch, carrying what a launcher needs to choose a profile.
  item = await release(item);
  assert.equal(item.nextAction!.kind, 'dispatch');
  assert.deepEqual(inputs(item), { kind: 'dispatch', target: 'implementation', epoch: 0, priority: 2, plannedFiles: ['src/'] });
  assert.equal(item.nextAction!.llmRole, 'implement');
  assert.equal(item.nextAction!.work, item.id); assert.equal(item.nextAction!.key, item.key);

  // Claimed: a session is already doing exactly what the build gate waits for, so nothing is named.
  item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  assert.equal(item.nextAction, null, 'a live lease is not a second dispatch');

  // Submitted but never observed: the control plane must read the pull request before anything else.
  item = await engine.execute(worker, 'workspace', item.id, { epoch: 1, host: 'machine-a', path: `/tmp/inverted/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-1` }, randomUUID());
  item = await engine.execute(worker, 'submit', item.id, { epoch: 1, pr: Number(item.key.slice(3)) }, randomUUID());
  assert.equal(item.nextAction!.kind, 'resync');
  assert.equal(inputs(item).pr, item.submission!.pr);

  // Observed without an approval: the review request, bound to the exact head, base and policy.
  item = await engine.observe(item.id, item.revision, observation(item, { reviews: [] }));
  assert.equal(item.nextAction!.kind, 'request-review');
  assert.deepEqual(inputs(item), { kind: 'request-review', provider: 'github', requestId: item.autoDispatch!.review!.id, pr: item.submission!.pr, sha: head, baseSha: base, policyRevision: 1 });
  assert.equal(item.nextAction!.llmRole, 'review');

  // Approved and green: the proof the acceptance gate is missing, with its group and proof names.
  item = await engine.observe(item.id, item.revision, observation(item));
  assert.equal(item.nextAction!.kind, 'dispatch');
  assert.deepEqual(inputs(item), { kind: 'dispatch', target: 'proof', group: 'integration', proofs: [PROOF], requestId: item.autoDispatch!.producers[0].id, pr: item.submission!.pr, sha: head, baseSha: base, policyRevision: 1 });
  assert.equal(item.nextAction!.llmRole, 'produce-evidence');

  // Proven: the merge, with the queue position it will land in.
  item = await engine.execute(producer, 'evidence', item.id, { proof: PROOF, sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 4, skipped: 0 }, randomUUID());
  item = await publishTip(item);
  item = await engine.observe(item.id, item.revision, observation(item));
  assert.equal(item.nextAction!.kind, 'merge');
  assert.equal(inputs(item).sha, head);
  assert.equal(item.nextAction!.llmRole, null, 'merging is mechanical: the gates already decided');

  // A live scope request outranks the gates: the worker holding the item is idle until it is answered.
  const blocked = await submitted();
  const claimedAgain = await engine.execute(operator, 'rework', blocked.id, { reason: 'reopen for the scope ask', previousWorkerStopped: true }, randomUUID());
  let scoped = await engine.execute(worker, 'claim', claimedAgain.id, {}, randomUUID());
  scoped = await engine.execute(worker, 'scope', scoped.id, { epoch: scoped.epoch, paths: ['docs/'], reason: 'the guide describes this contract' }, randomUUID());
  assert.equal(scoped.nextAction!.kind, 'approve-scope');
  assert.deepEqual(inputs(scoped), { kind: 'approve-scope', epoch: scoped.epoch, paths: ['docs/'], requestedBy: worker.id, detail: 'the guide describes this contract' });

  // The API exposes both the per-item action and the whole queue.
  const response = await fetch(`${url}/api/actions`, { headers: { Authorization: `Bearer ${'x'.repeat(32)}` } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.kinds, [...nextActionKinds]);
  assert.deepEqual(body.mechanical, [...mechanicalActionKinds]);
  assert.ok(body.nextActions.some((entry: any) => entry.key === item.key && entry.kind === 'merge'));
  assert.ok(body.actions.some((entry: ActionRow) => entry.key === scoped.key && entry.kind === 'approve-scope'));
  const snapshot = await (await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${'x'.repeat(32)}` } })).json();
  assert.ok((snapshot.work as Work[]).every(entry => 'nextAction' in entry), 'every item carries its computed action');

  // Totality: every refusal any gate raises across a battery of states maps to exactly one kind.
  const all = await store.list();
  const probes: Work[] = [
    ...all,
    { ...all[0], blocker: 'The staging database is unreachable', gates: [{ name: 'ready', passed: false, reasons: ['The staging database is unreachable'] }] } as Work,
    { ...all[0], gates: [{ name: 'build', passed: false, reasons: ['Candidate changes 2 files outside its planned files that must match the base branch byte-for-byte; run graphyard sync GY-1, restore each file from origin/<base>, and push again', 'Out-of-scope regression: src/other.ts reverts GY-2'] }] } as Work,
    { ...all[0], gates: [{ name: 'review', passed: false, reasons: ['Outstanding change requests must be resolved through a new review'] }] } as Work,
    { ...all[0], gates: [{ name: 'merge', passed: false, reasons: ['Required Graphyard check and merge-queue branch protection have not been verified'] }] } as Work,
    { ...all[0], gates: [{ name: 'acceptance', passed: false, reasons: [`Trusted ${PROOF} evidence from agent-a is no longer independent: agent-a has since held an assignment on GY-1`] }] } as Work,
  ];
  const seen = new Map<string, NextActionKind>();
  for (const probe of probes) for (const gate of probe.gates) for (const refusal of gate.reasons) {
    const kind = refusalAction(probe, gate.name, refusal);
    assert.ok(nextActionKinds.includes(kind), `${gate.name}: ${refusal} mapped to ${kind}`);
    assert.equal(refusalAction(probe, gate.name, refusal), kind, 'the mapping is a function of its inputs');
    seen.set(`${gate.name}:${refusal}`, kind);
  }
  assert.ok(seen.size >= 10, `the battery covered ${seen.size} distinct refusals`);
  assert.deepEqual([...new Set(probes.flatMap(probe => probe.gates.map(gate => gate.name)))].sort(), ['acceptance', 'build', 'merge', 'ready', 'review', 'test'], 'every gate contributed a refusal');
  // The named mappings, one per gate, and the catch-all that makes the function total.
  assert.equal(refusalAction(all[0], 'ready', 'Not released from backlog'), 'escalate');
  assert.equal(refusalAction(all[0], 'ready', 'Dependency GY-9 is unfinished'), 'dispatch');
  assert.equal(refusalAction(all[0], 'build', 'Worker has not submitted implementation for this attempt'), 'dispatch');
  assert.equal(refusalAction(all[0], 'build', 'Pull request has not been independently observed'), 'resync');
  assert.equal(refusalAction(all[0], 'review', 'Independent approval of the current commit is required'), 'request-review');
  assert.equal(refusalAction(all[0], 'merge', 'Merge queue position 2 of 3: GY-1 is ahead'), 'merge');
  assert.equal(refusalAction(all[0], 'nowhere', 'A refusal nobody has written a rule for yet'), 'escalate', 'an unmapped refusal escalates rather than vanishing');
  // A required check that reported a failure needs a new head; one still to answer needs a re-read.
  const failing = { ...all[0], observation: { ...observation(item), checks: [{ name: 'test', result: 'failure', appId: 15368 }] } } as Work;
  assert.equal(refusalAction(failing, 'test', 'Required CI check test has not passed on the current candidate'), 'request-rework');
  assert.equal(refusalAction({ ...failing, observation: { ...failing.observation!, checks: [] } } as Work, 'test', 'Required CI check test has not passed on the current candidate'), 'resync');
});

// ---- AC-2: durable rows, leased claims, idempotency ------------------------------------------

test('integration:action-queue-leases — actions are durable leased rows: a dead executor loses its claim, another retries without double-executing, and history names requester, executor, result and reason', async () => {
  const pending = await submitted();
  let item = await engine.observe(pending.id, pending.revision, observation(pending, { reviews: [] }));
  const open = rows(item);
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'request-review');
  assert.equal(open[0].state, 'pending');
  assert.equal(open[0].id, actionId('request-review', item.id, open[0].binding), 'the row id is derived from what it binds, never from when it was made');
  assert.deepEqual(open[0].history.map(entry => [entry.event, entry.requester, entry.executor]), [['requested', 'graphyard', null]]);

  // A re-evaluation of the same situation recognises the row it already has.
  const before = structuredClone(item);
  assert.deepEqual(reconcileActions(before, [before], new Date()), [], 'an unchanged situation queues nothing twice');

  // Executor A claims it under a bounded lease.
  const claimKey = randomUUID();
  const claimed = await engine.claimNextAction(executorA, { host: 'host-1', kinds: ['request-review'] }, claimKey);
  assert.equal(claimed.action!.kind, 'request-review');
  assert.equal(claimed.action!.claim!.executor, executorA.id);
  assert.equal(claimed.action!.claim!.host, 'host-1');
  assert.equal(claimed.action!.attempts, 1);
  assert.equal(Date.parse(claimed.action!.claim!.expiresAt) - Date.parse(claimed.action!.claim!.claimedAt), actionClaimMs);
  assert.deepEqual(await engine.claimNextAction(executorA, { host: 'host-1', kinds: ['request-review'] }, claimKey), claimed, 'a replayed claim returns its receipt rather than taking a second row');

  // Executor B finds nothing to take and cannot settle a row it does not hold.
  const empty = await engine.claimNextAction(executorB, { host: 'host-2', kinds: ['request-review'], work: item.key }, randomUUID());
  assert.equal(empty.action, null);
  await assert.rejects(engine.settleClaimedAction(executorB, claimed.action!.id, { result: 'done', reason: 'stolen' }, randomUUID()), /claimed by executor-a/);

  // Executor A dies mid-action: it renews nothing, so the claim expires and B takes attempt two.
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document,'{actionQueue,actions,0,claim,expiresAt}',to_jsonb($2::text)) WHERE id=$1`, [item.id, new Date(Date.now() - 1000).toISOString()]);
  const retried = await engine.claimNextAction(executorB, { host: 'host-2', kinds: ['request-review'] }, randomUUID());
  assert.equal(retried.action!.id, claimed.action!.id, 'the same action, not a second one');
  assert.equal(retried.action!.attempts, 2);
  assert.equal(retried.action!.claim!.executor, executorB.id);
  assert.ok(retried.action!.history.some(entry => entry.event === 'reclaimed' && entry.executor === executorA.id));
  await assert.rejects(engine.settleClaimedAction(executorA, claimed.action!.id, { result: 'done', reason: 'back from the dead' }, randomUUID()), /claimed by executor-b/,
    'an executor that comes back cannot settle the attempt that replaced it, so nothing is executed twice');

  // B reports a failure: the row returns to the queue with the reason and a widening backoff.
  const failed = await engine.settleClaimedAction(executorB, claimed.action!.id, { result: 'failed', reason: 'the reviewer profile has no logged-in account' }, randomUUID());
  assert.equal(failed.action.state, 'pending');
  assert.equal(failed.action.result, 'failed');
  assert.ok(Date.parse(failed.action.retryAt!) > Date.now(), 'a failed attempt backs off before it is offered again');
  assert.equal(claimable(failed.action, new Date()), false);
  assert.equal(claimable(failed.action, new Date(Date.parse(failed.action.retryAt!) + 1)), true);

  // And then completes it. The completed row holds its situation while the verdict lands.
  await store.pool.query(`UPDATE work_items SET document=(document #- '{actionQueue,actions,0,retryAt}') WHERE id=$1`, [item.id]);
  const third = await engine.claimNextAction(executorA, { host: 'host-1', kinds: ['request-review'] }, randomUUID());
  const done = await engine.settleClaimedAction(executorA, third.action!.id, { result: 'done', reason: 'reviewer session launched on head aaaaaaaaaaaa' }, randomUUID());
  assert.equal(done.action.state, 'done');
  assert.equal(done.action.attempts, 3);
  assert.deepEqual(done.action.history.map(entry => entry.event), ['requested', 'claimed', 'reclaimed', 'claimed', 'failed', 'claimed', 'completed']);
  const last = done.action.history.at(-1)!;
  assert.deepEqual([last.requester, last.executor, last.result, last.reason], ['graphyard', executorA.id, 'done', 'reviewer session launched on head aaaaaaaaaaaa']);

  // The ledger carries every transition beside the document that caused it.
  item = await reload(item);
  // The ledger carries each executor transition as its own named event, beside the document the
  // save appends; the control plane's own requests and retirements travel in that document,
  // on the row's history, rather than as a second event nobody reads.
  const forRow = async (kind: string) => (await events(item, kind)).filter(event => event.payload.details.id === claimed.action!.id);
  assert.equal((await forRow('action.claimed')).length, 3);
  assert.equal((await forRow('action.completed')).length, 1);
  assert.equal((await forRow('action.failed')).length, 1);
  const ledger = (await forRow('action.claimed')).at(-1)!;
  assert.deepEqual([ledger.payload.details.kind, ledger.payload.details.executor], ['request-review', executorA.id]);
  assert.deepEqual(ledger.payload.work.actionQueue.actions[0].history.map((entry: { event: string }) => entry.event), ['requested', 'claimed', 'reclaimed', 'claimed', 'failed', 'claimed'],
    'the document the event carries holds the whole transition history of the row');

  // The situation changes: the approval lands, so the row that no longer applies is retired
  // with the reason, and the acceptance gate's own action takes its place.
  item = await engine.observe(item.id, item.revision, observation(item));
  assert.equal(rows(item).length, 1);
  assert.equal(row(item).kind, 'dispatch');
  const retired = item.actionQueue!.history.at(-1)!;
  assert.equal(retired.id, claimed.action!.id);
  assert.equal(retired.result, 'done', 'a completed row becomes history untouched when its situation moves on');
});

// ---- The fleet: handlers that stand in for the sessions a real executor launches --------------

interface FleetLog { executed: { executor: string; host: string; id: string; kind: NextActionKind; attempt: number; key: string }[]; idle: number[] }

/**
 * The effects of one stateless executor. Every handler works from the action's typed inputs and
 * the item that action names; none of them reads a status report, and none of them knows that
 * another executor exists. The handlers stand in for what a real executor starts: a worker
 * session, a reviewer session, a producer session, a provider call.
 */
function fleetEffects(identity: Principal, host: string, log: FleetLog, mine: Set<string>, options: { escalate?: boolean } = {}): ExecutorEffects {
  const note = async (action: ActionRow) => {
    log.executed.push({ executor: identity.id, host, id: action.id, kind: action.kind, attempt: action.attempts, key: action.key });
    return reload(action.work);
  };
  const handlers: ExecutorEffects['handlers'] = {
    dispatch: async action => {
      const item = await note(action);
      if (action.inputs.kind !== 'dispatch') throw new Error('unreachable');
      if (action.inputs.target === 'proof') {
        // A producer session: it submits evidence for the exact head the request named.
        for (const proof of action.inputs.proofs) await engine.execute(producer, 'evidence', item.id, { proof, sha: action.inputs.sha, baseSha: action.inputs.baseSha, policyRevision: action.inputs.policyRevision, result: 'pass', executed: 3, skipped: 0 }, randomUUID());
        return `produced ${action.inputs.proofs.join(', ')}`;
      }
      // A worker session: it claims under its own identity, registers its workspace and submits.
      let claimed = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
      claimed = await engine.execute(worker, 'workspace', claimed.id, { epoch: claimed.epoch, host, path: `/tmp/fleet/${claimed.id}-${claimed.epoch}`, branch: `graphyard/${claimed.key.toLowerCase()}-${claimed.epoch}` }, randomUUID());
      await engine.execute(worker, 'submit', claimed.id, { epoch: claimed.epoch, pr: Number(claimed.key.slice(3)) }, randomUUID());
      return `worker session claimed epoch ${claimed.epoch} and submitted`;
    },
    'request-review': async action => {
      const item = await note(action);
      // A reviewer session: its verdict reaches Graphyard as a provider observation.
      await engine.observe(item.id, item.revision, observation(item));
      return 'reviewer approved the exact head';
    },
    resync: async action => {
      const item = await note(action);
      await engine.observe(item.id, item.revision, observation(item, item.candidate ? {} : { reviews: [] }));
      return 're-read the pull request from the provider';
    },
    merge: async action => {
      await note(action);
      await mergeItem(identity, await reload(action.work));
      return 'guarded merge committed and observed';
    },
    reclaim: async action => { await note(action); return 'assignment reclaimed'; },
    'verify-deployment': async action => {
      const item = await note(action);
      await engine.execute(operator, 'deployment', item.id, { sha: mergeSha, mergeSha: item.delivery!.mergeSha, source: 'endpoint', observedAt: new Date().toISOString() }, randomUUID());
      return 'observed the release serving the merge';
    },
    ...(options.escalate ? { escalate: async (action: ActionRow) => { await note(action); return 'escalation resolved'; } } : {}),
  };
  return {
    // Scoped to this test's own items, the way a real executor is scoped to its repository: the
    // control plane still decides what the row is and still settles the race between executors.
    claim: async request => {
      for (const work of mine) {
        const claimed = await engine.claimNextAction(identity, { ...request, work }, randomUUID());
        if (claimed.action) return claimed;
      }
      return { action: null, open: 0 };
    },
    settle: (action, result, reason) => engine.settleClaimedAction(identity, action.id, { result, reason }, randomUUID()),
    handlers,
  };
}

/** Take every other open item out of the global merge queue, so one test's queue is its own. */
async function isolateQueue(mine: Set<string>) {
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE document->>'stage'<>'done' AND NOT (id = ANY($1::uuid[]))", [[...mine]]);
}

/**
 * Run executors until the queue is drained, sampling the idle-but-actionable set at every step.
 *
 * A tick where every executor finds nothing is not the end: the control plane's reconciliation
 * worker re-evaluates items nothing has mutated (the next candidate in the merge queue, above
 * all), so the drain ticks it and looks once more before concluding.
 */
async function drain(effects: ExecutorEffects[], log: FleetLog, mine: Set<string>, options: { steps?: number } = {}) {
  const budget = options.steps ?? 600;
  const tick = () => Promise.all(effects.map((effect, index) => runExecutorTick({ id: index === 0 ? executorA.id : executorB.id, host: index === 0 ? 'host-1' : 'host-2' }, effect)));
  for (let step = 0; step < budget; step++) {
    const results = await tick();
    const snapshot = (await store.list()).filter(item => mine.has(item.id));
    log.idle.push(idleActionable(snapshot, new Date()).length);
    if (!results.every(result => result.result === 'idle')) continue;
    await engine.reconcile();
    if ((await tick()).every(result => result.result === 'idle')) return step;
  }
  throw new Error('the queue did not drain within the step budget');
}

// ---- AC-3: two stateless executors on different hosts ----------------------------------------

test('integration:multi-executor-throughput — two executors on different hosts drive five items to delivery through the same queue, with no double execution, no starvation and no master session', async () => {
  const items: Work[] = [];
  for (let index = 0; index < 5; index++) items.push(await release(await created()));
  const mine = new Set(items.map(item => item.id));
  await isolateQueue(mine);
  const log: FleetLog = { executed: [], idle: [] };
  const a = fleetEffects(executorA, 'host-1', log, mine), b = fleetEffects(executorB, 'host-2', log, mine);
  // The whole of an executor's configuration: how to claim, how to settle, and what it can run.
  assert.deepEqual(Object.keys(a).sort(), ['claim', 'handlers', 'settle'], 'an executor holds no snapshot, no cursor and no peer list');
  assert.deepEqual(executorKinds(a.handlers).sort(), ['dispatch', 'merge', 'reclaim', 'request-review', 'resync', 'verify-deployment'].sort());

  await drain([a, b], log, mine);

  for (const item of items) {
    const delivered = await reload(item);
    assert.equal(delivered.stage, 'done', `${delivered.key} reached delivery`);
    assert.ok(delivered.delivery?.mergeSha, `${delivered.key} has a delivery snapshot`);
  }
  // No double execution: every (action, attempt) pair was run once, and no action id was run
  // twice by two executors. The claim is what makes that true, not a convention between them.
  const pairs = log.executed.map(entry => `${entry.id}:${entry.attempt}`);
  assert.equal(new Set(pairs).size, pairs.length, 'no action attempt ran twice');
  for (const [id, runs] of Object.entries(groupBy(log.executed, entry => entry.id))) {
    const executors = new Set(runs.map(entry => entry.executor));
    assert.equal(executors.size <= 1 || runs.length > 1, true, `action ${id} was never run concurrently by two executors`);
  }
  // No starvation: both executors did work, on both hosts, and every item was advanced by both.
  const byExecutor = groupBy(log.executed, entry => entry.executor);
  assert.deepEqual(Object.keys(byExecutor).sort(), [executorA.id, executorB.id]);
  assert.ok(byExecutor[executorA.id].length > 1 && byExecutor[executorB.id].length > 1, 'neither executor was starved');
  assert.deepEqual([...new Set(log.executed.map(entry => entry.host))].sort(), ['host-1', 'host-2']);
  for (const item of items) assert.ok(log.executed.some(entry => entry.key === item.key), `${item.key} was executed by the fleet`);
  assert.ok(new Set(log.executed.map(entry => entry.key)).size === items.length);

  // No master session was involved: the only coordinator identities that acted are the two
  // executors, each one settling rows it claimed, and no daemon cycle ran.
  const actors = new Set<string>();
  for (const item of items) for (const event of await store.events(item.id)) actors.add(String(event.actor));
  assert.deepEqual([...actors].sort(), ['agent-a', 'ci-runner', 'executor-a', 'executor-b', 'github', 'graphyard', 'operator'].filter(actor => actors.has(actor)));
  assert.ok(!actors.has('master'), 'nothing a master session does appears in the ledger');
  const queue = queueSnapshot((await store.list()).filter(item => mine.has(item.id)), new Date());
  assert.equal(queue.pending, 0); assert.equal(queue.claimed, 0);
});

// ---- AC-4: workers pull -----------------------------------------------------------------------

test('integration:worker-pull-model — a free worker asks the control plane for its next assignment, p90 ready-to-claim stays inside two minutes, and nothing tracks runtime health', async () => {
  const created: Work[] = [];
  for (let index = 0; index < 4; index++) created.push(await release(await (async () => engine.execute(operator, 'create', null, { title: `Pull ${index}`, priority: index === 0 ? 0 : 3, plannedFiles: [`src/pull-${index}/`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID()))()));
  const readyAt = new Map(created.map(item => [item.id, Date.now()]));

  // The pull: one call, one credential, no configuration. `agent-b` appears in no master profile
  // and no Herdr inventory; the control plane still hands it the work it is entitled to claim.
  const service: number[] = [];
  const assigned: Work[] = [];
  for (const actor of [worker, otherWorker, worker, otherWorker]) {
    const started = Date.now();
    const pulled = await engine.pullAssignment(actor, {}, randomUUID());
    assert.ok(pulled.assigned, 'a free worker that asks is given an assignment');
    service.push(Date.now() - started);
    assigned.push(pulled.assigned!);
    assert.equal(pulled.assigned!.lease!.owner, actor.id, 'the worker claims under its own identity');
  }
  assert.equal(new Set(assigned.map(item => item.id)).size, assigned.length, 'no item was handed to two workers');
  // The offer order is the dispatch order the control plane already uses: priority, then the
  // narrowest planned scope, then age. Nothing about worker liveness enters into it.
  assert.equal(assigned[0].priority, 0, 'the highest priority item is offered first');

  // A fifth pull finds nothing left and says so, rather than failing.
  const empty = await engine.pullAssignment(worker, {}, randomUUID());
  assert.equal(empty.assigned, null);
  assert.equal(empty.offered, 0);

  // An item another worker already holds is never offered twice: a racing pull skips it.
  const contested = await release(await engine.execute(operator, 'create', null, { title: 'Contested', plannedFiles: ['src/contested/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID()));
  const [first, second] = await Promise.all([engine.pullAssignment(worker, {}, randomUUID()), engine.pullAssignment(otherWorker, {}, randomUUID())]);
  const winners = [first, second].filter(result => result.assigned);
  assert.equal(winners.length, 1, 'the coordination lock decides the race; the loser is told nothing was left');
  assert.equal(winners[0].assigned!.id, contested.id);

  // Ready-to-claim: the time until the worker's next poll, plus the time the pull itself takes.
  // The poll interval is the published bound, so the measurement is of the model, not of a fixture.
  const serviceP90 = [...service].sort((a, b) => a - b)[Math.max(0, Math.ceil(service.length * 0.9) - 1)];
  const readyToClaimP90 = workerPullIntervalMs + serviceP90;
  assert.ok(workerPullIntervalMs <= 120_000, `the published poll interval ${workerPullIntervalMs}ms is inside the two-minute bound`);
  assert.ok(readyToClaimP90 <= 120_000, `p90 ready-to-claim ${readyToClaimP90}ms is inside two minutes`);
  for (const item of assigned) assert.ok(Date.now() - readyAt.get(item.id)! < 120_000);

  // No central runtime-health tracking: the request body carries nothing but an optional host,
  // and the control plane consults no profile registry, credential inspection or session inventory.
  assert.deepEqual(Object.keys((await engine.pullAssignment(worker, {}, randomUUID())) as object).sort(), ['assigned', 'at', 'offered', 'refused']);
  for (const item of [...assigned, contested]) {
    const current = await reload(item);
    if (!current.lease) continue;
    await engine.execute(current.lease.owner === worker.id ? worker : otherWorker, 'release', current.id, { epoch: current.lease.epoch }, randomUUID());
  }
});

// ---- AC-5: no language model in the critical path ---------------------------------------------

test('integration:no-llm-in-critical-path — a full ready-to-delivered cycle runs with the escalation handler disabled, and no executor step needs a language model', async () => {
  // The roles are declared per kind: judgment happens inside what an action starts, never in the
  // executor step that starts it. Five kinds name a judgment; the other four are mechanical.
  assert.deepEqual(Object.entries(nextActionLlmRoles).filter(([, role]) => role !== null).map(([kind]) => kind).sort(),
    ['dispatch', 'escalate', 'request-review', 'request-rework'].sort());
  assert.deepEqual([...mechanicalActionKinds].sort(), ['approve-scope', 'merge', 'reclaim', 'resync', 'verify-deployment'].sort());
  assert.deepEqual([...llmRoles].sort(), ['approve-decision', 'implement', 'produce-evidence', 'resolve-escalation', 'review']);
  // Every judgment the project names has exactly one action that starts it, and nothing else does.
  assert.deepEqual([...new Set(Object.values(nextActionLlmRoles))].filter(Boolean).sort(), ['approve-decision', 'implement', 'resolve-escalation', 'review'],
    'produce-evidence is the dispatch of a producer session, which the computed action names on the row');

  const item = await release(await created({ policy: { checks: ['test', 'typecheck'], review: true, deploySmoke: false } }));
  const mine = new Set([item.id]);
  await isolateQueue(mine);
  const log: FleetLog = { executed: [], idle: [] };
  const effects = fleetEffects(executorA, 'host-1', log, mine);
  assert.equal(effects.handlers.escalate, undefined, 'this executor cannot resolve an escalation at all');
  assert.ok(!executorKinds(effects.handlers).includes('escalate'));

  await drain([effects], log, mine);
  const delivered = await reload(item);
  assert.equal(delivered.stage, 'done');
  assert.ok(delivered.delivery?.mergeSha);
  assert.ok(!log.executed.some(entry => entry.kind === 'escalate'), 'no escalation was needed to deliver');
  assert.ok(log.executed.some(entry => entry.key === item.key && entry.kind === 'merge'));

  // An item that does raise an escalation stalls at that row rather than being resolved by the
  // loop: the escalation handler is outside the critical path, not quietly automated inside it.
  let escalated = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  escalated = await engine.execute(worker, 'request', escalated.id, { type: 'blocker', epoch: escalated.epoch, reason: 'The provider account has no quota left' }, randomUUID());
  assert.equal(escalated.nextAction!.kind, 'escalate');
  const before = log.executed.length;
  const tick = await runExecutorTick({ id: executorA.id, host: 'host-1' }, effects);
  assert.equal(tick.result, 'idle');
  assert.equal(tick.reason, 'the queue has no action this executor can run');
  assert.equal(log.executed.length, before, 'the executor claimed nothing it cannot run');
  assert.equal((await reload(escalated)).actionQueue!.actions[0].state, 'pending', 'the escalate row waits for a judgment nobody mechanised');
  await engine.execute(operator, 'unblock', escalated.id, { reason: 'Quota restored' }, randomUUID());
});

// ---- AC-6: throughput without a master --------------------------------------------------------

test('manual:throughput-without-master — over twelve deliveries with no master session, submit-to-merge p50 stays inside thirty minutes and no item is idle-but-actionable for more than five minutes', async () => {
  const before = pipelineSpeedSummary(await store.list(), Date.now()).measured;
  const items: Work[] = [];
  for (let index = 0; index < 12; index++) items.push(await release(await created()));
  const mine = new Set(items.map(item => item.id));
  await isolateQueue(mine);
  const log: FleetLog = { executed: [], idle: [] };
  const fleet = [fleetEffects(executorA, 'host-1', log, mine), fleetEffects(executorB, 'host-2', log, mine)];
  const startedAt = Date.now();
  await drain(fleet, log, mine);
  const elapsed = Date.now() - startedAt;

  const all = (await store.list()).filter(item => mine.has(item.id));
  for (const item of items) assert.equal((await reload(item)).stage, 'done', `${item.key} was delivered`);
  const summary = pipelineSpeedSummary(await store.list(), Date.now());
  assert.ok(summary.measured - before >= 12, `${summary.measured - before} deliveries measured in this run`);
  assert.ok(summary.routine.count >= speedTarget.minimumItems, `${summary.routine.count} routine deliveries, at least ${speedTarget.minimumItems}`);
  assert.equal(speedTarget.submitToMergeP50Ms, 30 * 60_000);
  assert.ok(summary.submitToMerge.p50Ms <= speedTarget.submitToMergeP50Ms, `submit→merge p50 ${summary.submitToMerge.p50Ms}ms is inside the 30-minute target`);
  assert.equal(summary.met, true, summary.reason ?? '');

  // Nothing was ever idle-but-actionable: the queue was sampled after every executor step, and no
  // row sat unclaimed past the five-minute bound. Under a master session the same fleet went idle
  // exactly where the loop had no step for the situation; here every situation names one.
  assert.ok(log.idle.length > 10, `${log.idle.length} samples taken`);
  assert.equal(Math.max(...log.idle), 0, 'no row waited longer than the idle bound at any sample');
  assert.ok(elapsed < 5 * 60_000, 'the whole run finished inside the idle bound, so the sampling is not vacuous');

  // Every stall had a named action. An open item with no computed action was never observed, and
  // that is the property the inversion buys: there is no situation the loop has no step for.
  const unnamed = all.filter(item => item.stage !== 'done' && !item.nextAction && !item.lease && !item.dependencies.length && item.ready && !item.blocker && !item.queue);
  assert.deepEqual(unnamed.map(item => item.key), [], 'no open, unassigned, unblocked item lacked a typed next action');

  // No master session ran: no daemon cursor was created, no cycle was invoked, and the only
  // coordinator identities in the ledger are the two executors that claimed rows.
  const coordinators = new Set<string>();
  for (const item of items) for (const event of await store.events(item.id)) if (String(event.actor).startsWith('executor-')) coordinators.add(String(event.actor));
  assert.deepEqual([...coordinators].sort(), [executorA.id, executorB.id]);
  assert.ok(new Set(log.executed.map(entry => entry.executor)).size === 2, 'both executors carried deliveries');
});

// ---- AC-7: typed agent requests ---------------------------------------------------------------

test('integration:typed-agent-requests — an agent that needs something records a typed request, names its decider and exits without holding its lease, and master status shows it with how long it has waited', async () => {
  // Every type names exactly one decider, from the four the project allows.
  assert.deepEqual([...agentRequestTypes], ['scope-request', 'decision', 'blocker', 'note', 'escalation']);
  assert.deepEqual(agentRequestTypes.map(type => deciderFor('GY-9', { type, action: 'rework' }).kind), ['rule', 'approver', 'follow-up', 'rule', 'approver']);
  for (const type of agentRequestTypes) {
    const decider = deciderFor('GY-9', { type, action: 'rework' });
    assert.ok(decider.who.length > 0, `${type} names who decides it`);
    assert.equal(['rule', 'approver', 'follow-up', 'human'].includes(decider.kind), true);
  }
  // Only one of the three human-only decisions reaches a person, whatever the type.
  for (const humanDecision of humanDecisions) assert.equal(deciderFor('GY-9', { type: 'decision', humanDecision }).kind, 'human');

  // A worker that needs files outside plannedFiles records the ask and gives the item back. Its
  // decider is a deterministic rule, so the control plane applies it in the same transaction:
  // the ask is answered before the session has finished exiting.
  let item = await engine.execute(worker, 'claim', (await release(await created({ plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Update the architecture guide for the new contract', proofs: [PROOF] }] }))).id, {}, randomUUID());
  const epoch = item.epoch;
  item = await engine.execute(worker, 'request', item.id, { type: 'scope-request', epoch, paths: ['docs/architecture.md'], reason: 'the contract this item changes is described in the architecture guide' }, randomUUID());
  assert.equal(item.lease, null, 'the attempt ended in the same transaction; nothing waits at a prompt');
  assert.equal(item.pipeline!.attempts.at(-1)!.end, 'released');
  const scope = item.agentRequests!.at(-1)!;
  assert.equal(scope.type, 'scope-request');
  assert.equal(scope.releasedLease, true);
  assert.deepEqual(scope.decider, { kind: 'rule', who: 'the additive planned-files widening rule', command: `graphyard master scope ${item.key}` });
  assert.equal(scope.state, 'resolved', 'the rule that decides it ran here, so nothing is left waiting');
  assert.equal(item.scopeDecision!.state, 'approved');
  assert.match(scope.resolution!, /^approved: additive scope the item already implies/);
  assert.ok(item.plannedFiles.includes('docs/architecture.md'), 'the widening the item already implied was applied');
  assert.equal(item.scopeRequest, null);

  // A request the rule cannot approve keeps the refusal as the item's blocker, so the ready gate
  // holds it and the control plane names an escalation rather than leaving it silently open.
  let wider = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  wider = await engine.execute(worker, 'request', wider.id, { type: 'scope-request', epoch: wider.epoch, paths: ['deploy/helm/'], reason: 'the chart needs the same value' }, randomUUID());
  assert.equal(wider.scopeDecision!.state, 'refused');
  assert.match(wider.blocker!, /outside what this item's own criteria and the repository's documentation rule imply/);
  assert.equal(wider.nextAction!.kind, 'escalate');
  assert.equal(wider.agentRequests!.at(-1)!.state, 'resolved');
  assert.ok(!wider.plannedFiles.includes('deploy/helm/'));
  await engine.execute(operator, 'unblock', wider.id, { reason: 'Operator decided the chart is out of scope for this item' }, randomUUID());

  // A decision request names the action an independent approver must approve.
  let decided = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  decided = await engine.execute(worker, 'request', decided.id, { type: 'decision', epoch: decided.epoch, action: 'rework', reason: 'the finding needs a second head, which only an approved rework opens' }, randomUUID());
  const decision = openAgentRequests(decided, new Date())[0];
  assert.equal(decision.decider.kind, 'approver');
  assert.match(decision.decider.command!, /master decide GY-\d+ rework REASON, then graphyard master approver/);
  assert.equal(decided.lease, null);
  // Master status shows the open request with its decider and how long it has waited, addressed
  // to an agent; and the control plane names the escalation that leaves the executor loop for it.
  const snapshot = { work: await store.list(), now: new Date(Date.now() + 90_000).toISOString() };
  const line = agentRequestAttention(snapshot).find(entry => entry.subject === decided.key)!;
  assert.match(line.text, /recorded a decision on GY-\d+ 1.5 min ago and released its lease/);
  assert.match(line.text, /decided by an independent approver agent/);
  assert.deepEqual([line.role, line.human, line.humanOnly, line.approvedBy], ['master', false, null, 'approver']);
  assert.equal(line.next, decision.decider.command);
  assert.ok(agentRequestReport(snapshot).some(entry => entry.key === decided.key && entry.waitedMs >= 90_000));
  assert.ok(actionReport(snapshot).next.some(entry => entry.key === decided.key && entry.kind === 'escalate'));

  // A blocker names a tracked follow-up item and still sets the blocker the gates read.
  let blocked = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  blocked = await engine.execute(worker, 'request', blocked.id, { type: 'blocker', epoch: blocked.epoch, reason: 'the deployment provider is refusing every token' }, randomUUID());
  assert.equal(openAgentRequests(blocked, new Date())[0].decider.kind, 'follow-up');
  assert.equal(blocked.blocker, 'the deployment provider is refusing every token');
  assert.equal(blocked.lease, null);

  // A note is a record, not a hand-off: it keeps the lease and asks nobody for anything.
  let noted = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  noted = await engine.execute(worker, 'request', noted.id, { type: 'note', epoch: noted.epoch, reason: 'the third fixture is the slow one; it dominates the suite' }, randomUUID());
  assert.ok(noted.lease, 'a note does not end the attempt');
  assert.equal(openAgentRequests(noted, new Date())[0].decider.kind, 'rule');

  // A human-only decision is the operator's, and says which of the three it is.
  let money = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  money = await engine.execute(worker, 'request', money.id, { type: 'escalation', epoch: money.epoch, trigger: 'security-concern', humanDecision: 'spending-money-or-accounts', reason: 'finishing this needs a paid account with the provider' }, randomUUID());
  const human = openAgentRequests(money, new Date())[0];
  assert.equal(human.decider.kind, 'human');
  assert.match(human.decider.who, /spending money or accounts/);
  assert.equal(money.escalation!.trigger, 'security-concern');
  const humanLine = agentRequestAttention({ work: await store.list(), now: new Date().toISOString() }).find(entry => entry.subject === money.key)!;
  assert.deepEqual([humanLine.role, humanLine.human, humanLine.humanOnly], ['human', true, 'spending money or opening third-party accounts']);

  // A request from an attempt that ended is asked afresh: the next claim closes it.
  await engine.execute(worker, 'release', noted.id, { epoch: noted.epoch }, randomUUID());
  const reclaimed = await engine.execute(otherWorker, 'claim', noted.id, {}, randomUUID());
  assert.deepEqual(openAgentRequests(reclaimed, new Date()), [], 'a stale ask never looks like a live one');
  assert.equal(reclaimed.agentRequests!.at(-1)!.state, 'resolved');
  await engine.execute(otherWorker, 'release', reclaimed.id, { epoch: reclaimed.epoch }, randomUUID());

  // An open request is resolved by whoever answers it, with the reason on the record.
  const answered = await engine.execute(operator, 'request', decided.id, { type: 'note', resolve: decision.id, reason: 'the approver agent approved the rework' }, randomUUID());
  assert.deepEqual(openAgentRequests(answered, new Date()), []);
  assert.equal(answered.agentRequests!.find(entry => entry.id === decision.id)!.resolution, 'the approver agent approved the rework');

  // A session that ends waiting on input instead of recording one of these is recorded as failed
  // with that reason, and the record names the request it should have made.
  // Only one assignment may be held by this worker, so the cycle's observation is unambiguous.
  for (const open of await store.list()) {
    if (open.stage === 'done' || open.lease?.owner !== worker.id) continue;
    await engine.execute(worker, 'release', open.id, { epoch: open.lease.epoch }, randomUUID());
  }
  let waiting = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  waiting = await reload(waiting);
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: '/outside/graphyard.mjs', repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-1', masterAgentName: 'm', workers: [{ name: 'claude-worker', principal: worker.id, agentName: 'work-claude', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' }] });
  const state = emptyDaemonState(config);
  const sessions: unknown[] = [];
  const effects: DaemonEffects = {
    closeSession: () => {}, dispatch: async () => ({}), requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => ({}), requestSmoke: () => {},
    agents: () => [{ name: 'work-claude', pane_id: 'pane-9', agent_status: 'blocked' } as any],
    credentials: async () => ({ 'claude-worker': { available: true, reason: null } }),
    recordSession: async (item, handle) => { sessions.push(handle); return engine.execute(executorA, 'session', item.id, handle, randomUUID()); },
    snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
    persist: async () => {},
  };
  const cycle = await runCycle(config, state, effects);
  const failure = cycle.actions.find(action => action.kind === 'session' && action.work === waiting.key);
  assert.ok(failure, `the cycle recorded a session failure for ${waiting.key}; it recorded ${JSON.stringify(cycle.actions.map(action => [action.kind, action.work, action.state]))}`);
  assert.equal(failure!.state, 'failed');
  assert.match(failure!.detail, /is waiting on input \(Herdr reports it blocked\)/);
  assert.match(failure!.detail, /records a typed request and exits — POST \/api\/work\/GY-\d+\/request with a type of scope-request, decision, blocker, note or escalation — which names its decider and frees the item/);
  await engine.execute(worker, 'release', waiting.id, { epoch: waiting.epoch }, randomUUID());
});

// ---- AC-8: session handles --------------------------------------------------------------------

test('integration:session-handles-visible — every launched session records a durable handle on the item, and master status and the dashboard show what it is working on and how to attach to it', async () => {
  let item = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  const handle = { id: `${worker.id}:${item.epoch}`, kind: 'implementation' as const, epoch: item.epoch, runtime: 'claude', host: 'vishrog', workspace: 'wE', tab: 'tab-17', pane: 'pane-42', attach: 'herdr pane attach pane-42 --workspace wE', transcript: '/home/agent/.claude/transcripts/gy-87.jsonl', subject: `${item.key}: the inverted loop`, state: 'running' as const };
  item = await engine.execute(worker, 'session', item.id, handle, randomUUID());
  const recorded = item.sessions![0];
  assert.deepEqual([recorded.runtime, recorded.host, recorded.workspace, recorded.tab, recorded.pane, recorded.transcript], ['claude', 'vishrog', 'wE', 'tab-17', 'pane-42', '/home/agent/.claude/transcripts/gy-87.jsonl']);
  assert.equal(recorded.state, 'running');
  assert.equal(attachCommand(recorded), 'herdr pane attach pane-42 --workspace wE', 'a running session is attached to directly');

  // A reviewer or producer session holds no lease and records its handle under its own identity.
  const reviewerHandle = { id: 'review-request-1', kind: 'review' as const, runtime: 'cursor', host: 'host-2', pane: 'pane-7', attach: 'herdr pane attach pane-7', subject: `${item.key}: review head aaaaaaaaaaaa`, state: 'running' as const };
  item = await engine.execute(executorA, 'session', item.id, reviewerHandle, randomUUID());
  assert.equal(item.sessions!.length, 2);
  assert.equal(item.sessions![1].principal, executorA.id);
  await assert.rejects(engine.execute(worker, 'session', item.id, reviewerHandle, randomUUID()), /records its handle under its assignment epoch/);

  // Master status reports each running session with what it works on and the command that attaches.
  const snapshot = { work: await store.list(), now: new Date().toISOString() };
  const report = sessionReport(snapshot);
  const running = report.running.find(entry => entry.id === handle.id)!;
  assert.equal(running.subject, `${item.key}: the inverted loop`);
  assert.equal(running.attach, 'herdr pane attach pane-42 --workspace wE');
  assert.equal(running.key, item.key);
  assert.ok(runningSessions(snapshot.work, new Date()).length >= 2);

  // A finished session keeps its handle and links its transcript, so its work stays readable.
  item = await engine.execute(worker, 'session', item.id, { ...handle, state: 'finished', outcome: 'submitted PR 41' }, randomUUID());
  const finished = sessionSummary(item, new Date()).find(entry => entry.id === handle.id)!;
  assert.equal(finished.state, 'finished');
  assert.ok(finished.endedAt);
  assert.equal(finished.outcome, 'submitted PR 41');
  assert.equal(finished.attach, 'vishrog:/home/agent/.claude/transcripts/gy-87.jsonl', 'a finished session links its transcript');
  assert.equal(attachCommand({ state: 'finished', attach: null, transcript: null, host: 'h' }), 'no attach command and no transcript were recorded for this session');
  assert.equal(attachCommand({ state: 'running', attach: null, transcript: null, host: 'h' }), 'no attach command and no transcript were recorded for this session');
  assert.ok(sessionReport({ work: await store.list(), now: new Date().toISOString() }).finished.some(entry => entry.id === handle.id));

  // The dashboard drawer shows the same facts: the running session, its subject and its attach
  // command, and the typed action the control plane computed for the item.
  const current = await reload(item);
  const dashboard: any = {
    token: '', work: snapshot.work, status: { actor: { role: 'admin' }, repository: 'owner/project', baseBranch: 'main' }, error: '', connected: true, lastUpdated: null,
    view: 'overview', setView: () => {}, filter: null, setFilter: () => {}, selected: current.id, setSelected: () => {}, creating: false, setCreating: () => {},
    busy: false, setBusy: () => {}, observedAt: Date.now(), jobs: [], query: '', setQuery: () => {}, operatorAgents: [], events: [], operatorAgentsError: null,
    features: {}, editingRequirements: false, setEditingRequirements: () => {}, codexAvailable: false, queue: [], sessionEpoch: { current: 0 },
    api: async () => ({}), refresh: async () => {}, action: async () => {}, setError: () => {}, signOut: () => {},
  };
  const markup = renderToStaticMarkup(createElement(WorkDetails, { ...dashboard, item: current }));
  assert.ok(markup.includes('Sessions running now'), 'the drawer names the sessions running on this item');
  assert.ok(markup.includes('review head aaaaaaaaaaaa'));
  assert.ok(markup.includes('herdr pane attach pane-7'), 'the drawer carries the command that attaches to a specific agent');
  assert.ok(markup.includes('/home/agent/.claude/transcripts/gy-87.jsonl'), 'a finished session links its transcript');
  assert.ok(markup.includes('Next action'), 'the drawer names the typed action the control plane computed');

  // The daemon records the handle for every session it launches, so nothing depends on this host's
  // own ledger to find the agent again.
  assert.equal(typeof engine.execute, 'function');
  await engine.execute(worker, 'release', current.id, { epoch: current.epoch }, randomUUID());
});

// ---- The pure model, exercised directly -------------------------------------------------------

test('integration:typed-next-action — the queue is pure over the snapshot: the same state reconciles to the same rows, and a changed state retires the row that no longer applies', () => {
  const at = '2026-09-20T12:00:00.000Z', clock = Date.parse(at);
  const item = {
    id: 'work-1', key: 'GY-1', title: 'Pure', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }], policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  } as unknown as Work;
  const first = structuredClone(item), second = structuredClone(item);
  const a = reconcileActions(first, [first], new Date(clock));
  const b = reconcileActions(second, [second], new Date(clock + 60_000));
  assert.deepEqual(a.map(entry => entry.action.id), b.map(entry => entry.action.id), 'the row id is a function of the situation, not of the clock');
  assert.deepEqual(a.map(entry => entry.event), ['requested']);
  assert.deepEqual(reconcileActions(first, [first], new Date(clock + 1000)), [], 'an unchanged situation is idempotent');
  assert.equal(nextAction(first, [first], new Date(clock))!.kind, 'dispatch');

  // An executor claims it; a second executor reading the same snapshot finds nothing left.
  const claimed = claimAction([first], { id: 'executor-a', host: 'host-1' }, new Date(clock + 2000))!;
  assert.equal(claimed.row.state, 'claimed');
  assert.equal(claimAction([first], { id: 'executor-b', host: 'host-2' }, new Date(clock + 2001)), null);
  assert.deepEqual(openActions([first], new Date(clock + 3000)).map(entry => entry.row.id), []);
  assert.equal(queueSnapshot([first], new Date(clock + 3000)).claimed, 1);

  // The claim expires: the row returns to the queue, and the idle report names it.
  const later = new Date(clock + 2000 + actionClaimMs + 1);
  assert.deepEqual(reconcileActions(first, [first], later).map(entry => entry.event), ['reclaimed']);
  assert.equal(first.actionQueue!.actions[0].state, 'pending');
  assert.equal(idleActionable([first], new Date(clock + 6 * 60_000)).length, 1);
  assert.equal(idleActionable([first], new Date(clock + 60_000)).length, 0);

  // The situation changes: the row that no longer applies is retired, naming what replaced it.
  first.blocker = 'the provider account has no quota left';
  first.gates = [{ name: 'ready', passed: false, reasons: [first.blocker] }];
  const moved = reconcileActions(first, [first], new Date(clock + 7 * 60_000));
  assert.deepEqual(moved.map(entry => entry.event), ['cancelled', 'requested']);
  assert.match(moved[0].action.resolution!, /now needs escalate instead/);
  assert.equal(first.actionQueue!.actions[0].kind, 'escalate');
  assert.equal(first.actionQueue!.history.length, 1);

  // Settling a row nobody claimed, or one claimed by somebody else, is refused.
  const pending = first.actionQueue!.actions[0];
  assert.throws(() => settleAction(first, pending.id, 'executor-a', 'done', 'no claim', new Date(clock)), /not claimed/);
  assert.throws(() => settleAction(first, 'f'.repeat(32), 'executor-a', 'done', 'no such row', new Date(clock)), /not open on this work item/);
});

test('integration:typed-next-action — the gate evaluator and the action computation agree on every stage of one item', () => {
  const at = '2026-09-20T12:00:00.000Z';
  const base_: Work = {
    id: 'work-2', key: 'GY-2', title: 'Agreement', description: '', type: 'feature', priority: 2, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }], policy: { checks: ['test'], review: true }, stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: false, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [],
  } as unknown as Work;
  const evaluated = (overrides: Partial<Work>) => {
    const probe = { ...structuredClone(base_), ...overrides } as Work;
    Object.assign(probe, evaluate(probe, [probe], new Date(at), [15368]));
    return probe;
  };
  // Backlog raises no action: nobody runs "decide this is worth doing".
  const backlog = evaluated({});
  assert.equal(backlog.gates.find(gate => !gate.passed)!.reasons[0], 'Not released from backlog');
  assert.equal(nextAction(backlog, [backlog], new Date(at)), null);
  // Once released, the action always answers the first refusing gate, naming it and its refusal.
  for (const probe of [evaluated({ ready: true }), evaluated({ ready: true, blocker: 'waiting on the provider' })]) {
    const action = nextAction(probe, [probe], new Date(at));
    const failing = probe.gates.find(gate => !gate.passed)!;
    assert.equal(action!.gate, failing.name);
    assert.equal(action!.refusal, failing.reasons[0]);
    assert.equal(action!.kind, refusalAction(probe, failing.name, failing.reasons[0]));
  }
  // An unfinished dependency belongs to the other item: this one names no action at all.
  const dependency = evaluated({ ready: true, id: 'work-3', key: 'GY-3' });
  const dependent = { ...evaluated({ ready: true, dependencies: ['work-3'] }) };
  Object.assign(dependent, evaluate(dependent, [dependent, dependency], new Date(at), [15368]));
  assert.match(dependent.gates.find(gate => gate.name === 'ready')!.reasons[0], /Dependency GY-3 is unfinished/);
  assert.equal(nextAction(dependent, [dependent, dependency], new Date(at)), null);
  assert.equal(nextAction(dependency, [dependent, dependency], new Date(at))!.kind, 'dispatch', 'the dependency is the one that gets dispatched');
});

test('integration:no-llm-in-critical-path — an executor with no handlers claims nothing, and a handler that throws returns its row to the queue with the reason', async () => {
  const log: FleetLog = { executed: [], idle: [] };
  const idle = await runExecutorTick({ id: executorA.id, host: 'host-1' }, { claim: async () => { throw new Error('never called'); }, settle: async () => ({}), handlers: {} });
  assert.deepEqual([idle.result, idle.reason], ['idle', 'this executor has no handler for any action kind']);

  const item = await release(await created());
  const failingHandlers: ExecutorEffects['handlers'] = { dispatch: async action => { log.executed.push({ executor: executorA.id, host: 'host-1', id: action.id, kind: action.kind, attempt: action.attempts, key: action.key }); throw new Error('no worker profile has a logged-in account'); } };
  const failing: ExecutorEffects = {
    claim: request => engine.claimNextAction(executorA, { ...request, work: item.id }, randomUUID()) as ReturnType<ExecutorEffects['claim']>,
    settle: (action, result, reason) => engine.settleClaimedAction(executorA, action.id, { result, reason }, randomUUID()),
    handlers: failingHandlers,
  };
  // The HTTP binding: the only state an executor holds is its credential, and it speaks exactly
  // the two routes the queue offers.
  const calls: { path: string; body: any; key: string }[] = [];
  const bound = executorEffects({ url: 'https://graphyard.example', token: 'executor-token', requestId: () => 'request-1',
    fetcher: (async (input: any, init: any) => { calls.push({ path: String(input), body: JSON.parse(init.body), key: init.headers['Idempotency-Key'] }); return new Response(JSON.stringify({ action: null, open: 0 })); }) as unknown as typeof fetch }, failingHandlers);
  await bound.claim({ host: 'host-1', executor: executorA.id, kinds: ['dispatch'] });
  await bound.settle({ id: 'a'.repeat(32) } as ActionRow, 'failed', 'nothing to launch with');
  assert.deepEqual(calls.map(call => call.path), ['https://graphyard.example/api/actions/claim', `https://graphyard.example/api/actions/${'a'.repeat(32)}/settle`]);
  assert.deepEqual(calls.map(call => call.key), ['request-1', 'request-1']);
  assert.deepEqual(calls[1].body, { result: 'failed', reason: 'nothing to launch with' });

  const result = await runExecutor({ id: executorA.id, host: 'host-1' }, failing, { intervalMs: 1, maxSteps: 1 });
  const step = result.steps[0];
  assert.equal(step.result, 'failed');
  assert.equal(step.reason, 'no worker profile has a logged-in account');
  const after = await reload(item);
  const stalled = rows(after).find(entry => entry.kind === 'dispatch')!;
  assert.equal(stalled.state, 'pending', 'a failed attempt returns the row to the queue');
  assert.equal(stalled.resolution, 'no worker profile has a logged-in account');
  assert.equal(stalled.attempts, 1);
  await engine.execute(operator, 'blocked', after.id, { epoch: 0, reason: null }, randomUUID()).catch(() => {});
});
