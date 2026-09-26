import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
import type { NextAction } from '../src/model/action-kinds.js';
import { actionId, actionStallMaxMs, claimAction, reconcileActions, settleAction, settleDelivered } from '../src/model/actions.js';
import { nextAction } from '../src/model/next-action.js';
import { livenessCarry, livenessOf, livenessRetryLimit, livenessViolations, livenessWaitBoundMs, type ViolationClass } from '../src/model/liveness.js';
import { livenessStatus } from '../src/cli/liveness-report.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { emptyDaemonState, writeDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-201: every open item always has exactly one owned next step with a deadline, and the server
 * keeps it that way. Each test is named for the proof it produces and runs the real engine on a
 * disposable Postgres; the stranded states are the record as the incidents left it — the owed row
 * gone — rather than states this test invents.
 */
const repository = 'owner/project';
const PROOF = 'integration:liveness-proof';
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: [PROOF] };
const base = 'b'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
let pg: EmbeddedPostgres, store: Store, engine: Engine;
let serial = 0;

before(async () => {
  // An offset no other test file takes: two files sharing a port fail in their `before` hook.
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 201;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('liveness'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('liveness_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/liveness_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  engine.principals = [operator, worker, coordinator, producer];
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const id = () => randomUUID();
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.pool.query('SELECT payload FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq', [work.id, kind])).rows.map(row => row.payload.details);
const setDocument = (work: Work, path: string, value: unknown) => store.pool.query('UPDATE work_items SET document=jsonb_set(document,$2::text[],$3::jsonb) WHERE id=$1', [work.id, `{${path}}`, JSON.stringify(value)]);
/** The record as a stranded item was found: whatever row owned its next step is gone. */
const strand = (work: Work) => setDocument(work, 'actionQueue', { actions: [], history: [] });
const judge = async (work: Work) => { const all = await store.list(); return livenessOf(all.find(item => item.id === work.id)!, all, new Date()); };
const rows = (work: Work) => work.actionQueue?.actions ?? [];
const head = (work: Work) => work.candidate?.sha ?? sha(work.key);
const observation = (work: Work, extra: Partial<Observation> = {}): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head(work), baseSha: base, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
  checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head(work), state: 'APPROVED' }],
  protected: true, mergeable: true, merged: false, mergeSha: null, baseTip: base, baseTree: '7e'.repeat(20), files: [], scopeFiles: [], at: new Date().toISOString(), ...extra });

const released = async () => {
  const n = ++serial;
  const created = await engine.execute(operator, 'create', null, { title: `Liveness ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: [PROOF] }] }, id());
  return engine.execute(operator, 'ready', created.id, {}, id());
};
const claimed = async () => engine.execute(worker, 'claim', (await released()).id, {}, id());
/** A submitted, observed candidate; `evidence` decides what its proof says. */
async function candidate(evidence: 'pass' | 'fail' | null, extra: Partial<Observation> = {}, alone = false) {
  let w = await claimed();
  // Alone in the merge queue, so a proven candidate is first rather than waiting behind another.
  if (alone) await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [w.id]);
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/liveness-${w.key}`, branch: `graphyard/${w.key.toLowerCase()}-1` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 900 + serial }, id());
  w = await engine.observe(w.id, w.revision, observation(w, extra));
  if (evidence) w = await engine.execute(producer, 'evidence', w.id, { proof: PROOF, sha: head(w), baseSha: base, policyRevision: w.policyRevision, result: evidence, executed: 3, skipped: 0,
    ...(evidence === 'pass' ? { exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } } : {}) }, id());
  return engine.observe(w.id, (await reload(w)).revision, observation(w, extra));
}
async function refusedScope() {
  const w = await claimed();
  await engine.execute(worker, 'scope', w.id, { epoch: w.epoch, paths: ['web/unrelated.tsx'], reason: 'The page is easier to change here too' }, id());
  const decided = await engine.execute(coordinator, 'autoscope', w.id, { epoch: w.epoch }, id());
  assert.equal(decided.scopeRequest?.decision?.state, 'refused', 'the rule refused a path the item does not imply');
  return decided;
}
async function staleWait() {
  // A draft pull request: no producer request may stand for its head, so the item waits on an
  // event outside it. Entered an hour ago, the wait is past its bound.
  const w = await candidate(null, { draft: true });
  assert.equal(nextAction(w, await store.list(), new Date()), null, `the draft waits: ${JSON.stringify(w.nextAction)}`);
  await setDocument(w, 'stageEnteredAt', new Date(Date.now() - 2 * livenessWaitBoundMs).toISOString());
  return reload(w);
}
// ---- AC-1 ---------------------------------------------------------------------------------------

test('unit:liveness-violations-detected — every open item holds exactly one obligation (a live leased session, an open action row, or a named wait with a dueAt) and an item holding none is a violation, classified by its state: a stranded merge with no execution and an open PR, a retained merge execution past its authority, a failed proof with no rework, a refused scope request, and a wait past its dueAt', async () => {
  const now = () => new Date();
  // Healthy items each hold one obligation, with a due time.
  const ready = await released();
  const healthy = await judge(ready);
  assert.equal(healthy.violation, null);
  assert.equal(healthy.obligation!.kind, 'action');
  assert.equal(healthy.obligation!.action!.kind, 'dispatch');
  assert.ok(Date.parse(healthy.obligation!.dueAt) > Date.now(), 'an open row is due by its idle bound');
  const building = await judge(await claimed());
  assert.equal(building.violation, null);
  assert.equal(building.obligation!.kind, 'session', 'the leased worker owns the build');
  const backlog = await engine.execute(operator, 'create', null, { title: 'Backlog', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: [PROOF] }] }, id());
  assert.deepEqual(await judge(backlog), { work: backlog.id, key: backlog.key, obligation: null, violation: null }, 'backlog is not open work');

  // The stranded states, each as the incident left the record.
  const merge = await candidate('pass', {}, true);
  assert.equal(nextAction(merge, await store.list(), now())?.kind, 'merge', `the proven candidate is owed its merge: ${merge.gates.flatMap(gate => gate.reasons).join('; ')}`);
  assert.equal(merge.mergeExecution ?? null, null);
  assert.equal(merge.observation!.merged, false, 'its pull request is open');
  const failed = await candidate('fail');
  const scope = await refusedScope();
  const stale = await staleWait();
  for (const item of [merge, failed, scope]) await strand(item);

  const expected: [Work, ViolationClass, string][] = [[merge, 'stranded-merge', 'merge'], [failed, 'failed-proof', 'request-rework'],
    [scope, 'refused-scope', 'escalate'], [stale, 'stale-wait', 'escalate']];
  const found = livenessViolations(await store.list(), now());
  for (const [item, kind, successor] of expected) {
    const verdict = await judge(item);
    assert.equal(verdict.obligation, null, `${item.key} holds nothing`);
    assert.equal(verdict.violation?.class, kind, `${item.key}: ${JSON.stringify(verdict.violation)}`);
    assert.equal(verdict.violation!.successor?.kind, successor, `${item.key} is owed ${successor}`);
    assert.ok(verdict.violation!.ageMs >= 0 && Date.parse(verdict.violation!.since) <= Date.now(), 'with an age');
    assert.ok(found.some(entry => entry.key === item.key), `${item.key} is listed among the violations`);
  }
  assert.deepEqual(found.map(entry => entry.key).sort(), expected.map(([item]) => item.key).sort(), 'and nothing healthy is');
  // What each is owed, precisely: the refused scope request a scope decision naming the command,
  // the stale wait an escalation.
  // The live attempt's additive request is the independent approver's to judge (GY-176 routes it);
  // one the loop cannot route (here it also asks for a criteria change) names the master's command.
  const decision = (await judge(scope)).violation!.successor!;
  assert.ok(decision.inputs.kind === 'escalate' && decision.inputs.trigger === 'scope' && decision.inputs.detail.includes(`graphyard master decisions ${scope.key}`) && !decision.inputs.detail.includes('graphyard master scope'), JSON.stringify(decision));
  const everything = await store.list(), stored = everything.find(item => item.id === scope.id)!;
  const unroutable = { ...stored, scopeRequest: { ...stored.scopeRequest!, criteria: [{ id: 'AC-9', text: 'A new criterion' }] } } as Work;
  const master = livenessOf(unroutable, everything.map(item => item.id === scope.id ? unroutable : item), new Date()).violation!.successor!;
  assert.ok(master.inputs.kind === 'escalate' && master.inputs.detail.includes(`graphyard master scope ${scope.key}`), JSON.stringify(master));
  const escalation = (await judge(stale)).violation!.successor!;
  assert.ok(escalation.inputs.kind === 'escalate' && escalation.inputs.trigger === 'stale-wait', JSON.stringify(escalation));

  // Two states no rule answers at all are violations too, never silence: a gate refusing with no
  // reason, and a wait on an item that does not exist.
  const at = new Date().toISOString();
  const shell = (key: string, overrides: Partial<Work>) => ({ id: `id-${key}`, key, title: key, type: 'feature', priority: 1, epoch: 1, revision: 1, policyRevision: 1, stage: 'review', ready: true,
    createdAt: at, updatedAt: at, stageEnteredAt: at, criteria: [], plannedFiles: ['src/'], dependencies: [], evidence: [], workspaces: [], violations: [], blocker: null, lease: null,
    submission: { epoch: 1, pr: 1 }, candidate: null, observation: null, policy: { checks: [], review: true }, gates: [], ...overrides } as unknown as Work);
  const mute = shell('GY-MUTE', { gates: [{ name: 'review', passed: false, reasons: [] }] });
  const orphan = shell('GY-ORPHAN', { stage: 'build', gates: [{ name: 'ready', passed: false, reasons: ['Dependency GY-GONE is unfinished'] }] });
  assert.equal(livenessOf(mute, [mute], now()).violation?.class, 'unaccounted');
  assert.equal(livenessOf(orphan, [orphan], now()).violation?.class, 'stale-wait');
});

// ---- AC-2 ---------------------------------------------------------------------------------------

test('unit:violations-get-successor-actions — one reconciliation tick opens exactly one successor for each violation (merge, reconcile-merge, request-rework, scope decision, escalate), deduplicated by reason across ticks, and an action failing N times for one unchanged reason is converted to escalate instead of retried', async () => {
  const merge = await candidate('pass', {}, true), failed = await candidate('fail'), scope = await refusedScope(), stale = await staleWait();
  for (const item of [merge, failed, scope]) await strand(item);
  const cases: [Work, ViolationClass, string, string | null][] = [[merge, 'stranded-merge', 'merge', null],
    [failed, 'failed-proof', 'request-rework', null], [scope, 'refused-scope', 'escalate', 'scope'], [stale, 'stale-wait', 'escalate', 'stale-wait']];
  for (const [item, kind] of cases) assert.equal((await judge(item)).violation?.class, kind, `${item.key} starts in violation`);

  await engine.reconcile();
  for (const [item, kind, successor, tag] of cases) {
    const after = await reload(item);
    const verdict = await judge(item);
    assert.equal(verdict.violation, null, `${item.key} is repaired within one tick: ${JSON.stringify(verdict.violation)}`);
    assert.equal(verdict.obligation!.kind, 'action');
    const owed = rows(after).filter(row => row.kind === successor);
    assert.equal(owed.length, 1, `${item.key}: exactly one ${successor} row`);
    if (tag) assert.ok(owed[0].inputs.kind === 'escalate' && owed[0].inputs.trigger === tag, JSON.stringify(owed[0].inputs));
    const repaired = await events(item, 'liveness.repaired');
    assert.equal(repaired.length, 1, `${item.key}: the repair is on the ledger`);
    assert.equal(repaired[0].class, kind);
    assert.equal(repaired[0].successor.id, owed[0].id, 'naming the row it opened');
  }

  // A second tick finds nothing to repair and queues nothing twice: every successor's id is
  // derived from its reason.
  const before = Object.fromEntries(await Promise.all(cases.map(async ([item]) => [item.id, rows(await reload(item)).map(row => row.id)] as const)));
  await engine.reconcile();
  for (const [item] of cases) {
    const ids = rows(await reload(item)).map(row => row.id);
    assert.deepEqual(ids, before[item.id], `${item.key}: no duplicate after a second tick`);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal((await events(item, 'liveness.repaired')).length, 1, `${item.key}: nothing further to repair`);
  }

  // N failures for one unchanged reason: retried below the limit, escalated at it.
  const item = await released();
  const reason = 'every worker profile is busy or unavailable (claude-a: busy)';
  const dispatchId = rows(item).find(row => row.kind === 'dispatch')!.id;
  const fail = async () => {
    await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{actionQueue,actions}',(SELECT jsonb_agg(row - 'retryAt') FROM jsonb_array_elements(document->'actionQueue'->'actions') row)) WHERE id=$1", [item.id]);
    const taken = await engine.claimNextAction(coordinator, { host: 'host-1', kinds: ['dispatch'], work: item.key }, id());
    assert.equal(taken.action?.id, dispatchId, 'the dispatch row is offered');
    await engine.settleClaimedAction(coordinator, dispatchId, { result: 'failed', reason }, id());
  };
  for (let failure = 1; failure < livenessRetryLimit; failure++) await fail();
  await engine.reconcile();
  let current = await reload(item);
  assert.equal(current.nextAction?.kind, 'dispatch', `${livenessRetryLimit - 1} identical failures are still retried`);
  await fail();
  await engine.reconcile();
  current = await reload(item);
  assert.equal(current.nextAction?.kind, 'escalate', `the ${livenessRetryLimit}th identical failure converts it`);
  assert.ok(current.nextAction!.inputs.kind === 'escalate' && current.nextAction!.inputs.trigger === 'stalled-action' && current.nextAction!.inputs.detail.includes(reason));
  assert.deepEqual(rows(current).map(row => row.kind), ['escalate'], 'the dispatch is retired, not retried');
  const escalationId = rows(current)[0].id;
  await engine.reconcile();
  current = await reload(item);
  assert.deepEqual(rows(current).map(row => row.id), [escalationId], 'and it stays converted: one escalation, no dispatch reopened');
  assert.equal((await engine.claimNextAction(coordinator, { host: 'host-1', kinds: ['dispatch'], work: item.key }, id())).action, null, 'no executor is offered the dispatch again');
  assert.equal((await judge(item)).violation, null, 'the escalation owns the item');
  assert.equal(actionId('escalate', item.id, rows(current)[0].binding), escalationId);
});

test('unit:violations-get-successor-actions — a stalled action is escalated, never abandoned: after N identical verify-deployment failures the row is retried once the widest stall backoff has passed, re-escalated at once on the same failure, and a deployment observed on a later attempt verifies the delivery', () => {
  const t0 = Date.parse('2026-09-20T10:00:00.000Z');
  let clock = t0;
  const now = () => new Date(clock);
  const at = new Date(t0).toISOString(), mergeSha = 'e'.repeat(40);
  const work = { id: 'id-GY-DEPLOY', key: 'GY-DEPLOY', title: 'Deploy', type: 'feature', priority: 1, epoch: 1, revision: 1, policyRevision: 1, stage: 'done', ready: true,
    createdAt: at, updatedAt: at, stageEnteredAt: at, criteria: [], plannedFiles: ['src/'], dependencies: [], evidence: [], workspaces: [], violations: [], blocker: null, lease: null,
    submission: { epoch: 1, pr: 1 }, candidate: null, observation: null, policy: { checks: [], review: true, deploySmoke: true }, gates: [],
    delivery: { mergedAt: at, mergeSha, authorizationRevision: 1 } } as unknown as Work;
  const executor = { id: 'executor-1', host: 'host-1', principal: 'coordinator' };
  const reason = 'the deployment endpoint answered 503 Service Unavailable';
  settleDelivered(work, [work], now());
  assert.equal(work.nextAction?.kind, 'verify-deployment');
  const verifyId = work.actionQueue!.actions[0].id;
  /** One failed attempt, settled and reconciled at the instant it failed; the row's backoff is returned, not waited out. */
  const attempt = () => {
    const taken = claimAction([work], executor, now());
    assert.equal(taken?.row.id, verifyId, `the verify-deployment row is offered at ${now().toISOString()}`);
    clock += 1000;
    const settled = settleAction(work, verifyId, { executor: executor.id, principal: executor.principal }, 'failed', reason, now());
    settleDelivered(work, [work], now());
    return Date.parse(settled.action.retryAt!);
  };
  for (let failure = 1; failure < livenessRetryLimit; failure++) {
    const retryAt = attempt();
    assert.equal(work.nextAction?.kind, 'verify-deployment', `failure ${failure} is retried`);
    clock = retryAt;
  }
  attempt();
  const lastFailure = clock;
  assert.equal(work.nextAction?.kind, 'escalate', `the ${livenessRetryLimit}th identical failure escalates`);
  assert.ok(work.nextAction!.inputs.kind === 'escalate' && work.nextAction!.inputs.trigger === 'stalled-action');
  assert.equal(claimAction([work], executor, now()), null, 'nothing is offered while the escalation is fresh');
  clock = lastFailure + actionStallMaxMs - 60_000;
  settleDelivered(work, [work], now());
  assert.equal(work.nextAction?.kind, 'escalate', 'the escalation holds inside the widest stall backoff');
  clock = lastFailure + actionStallMaxMs;
  settleDelivered(work, [work], now());
  assert.equal(work.nextAction?.kind, 'verify-deployment', 'once it has passed, the action is owed again rather than abandoned');
  assert.deepEqual(work.actionQueue!.actions.map(row => row.kind), ['verify-deployment'], 'the escalation row makes way for the retry');
  attempt();
  assert.equal(work.nextAction?.kind, 'escalate', 'the same failure on the retry escalates again at once');
  clock += actionStallMaxMs;
  settleDelivered(work, [work], now());
  assert.equal(work.nextAction?.kind, 'verify-deployment', 'and is retried again after the next backoff');
  // The incident ends: this attempt observes the deployment.
  const taken = claimAction([work], executor, now());
  assert.equal(taken?.row.id, verifyId);
  work.delivery!.deployment = { sha: mergeSha, mergeSha, source: 'endpoint', observedAt: now().toISOString() } as NonNullable<Work['delivery']>['deployment'];
  settleAction(work, verifyId, { executor: executor.id, principal: executor.principal }, 'done', 'deployment observed', now());
  settleDelivered(work, [work], now());
  assert.notEqual(work.nextAction?.kind, 'verify-deployment', 'the delivery is verified');
  assert.notEqual(work.nextAction?.kind, 'escalate');
  assert.deepEqual(work.actionQueue!.actions.filter(row => row.state !== 'done').map(row => row.kind), [], 'nothing is left owed');
});

test('unit:violations-get-successor-actions — resync and request-review rows refused for one stable reason keep being retried on the widest backoff after they escalate', () => {
  for (const kind of ['resync', 'request-review'] as const) {
    const t0 = Date.parse('2026-09-20T10:00:00.000Z');
    let clock = t0;
    const now = () => new Date(clock);
    const at = new Date(t0).toISOString();
    const work = { id: `id-${kind}`, key: `GY-${kind.toUpperCase()}`, title: kind, type: 'feature', priority: 1, epoch: 1, revision: 1, policyRevision: 1, stage: 'review', ready: true,
      createdAt: at, updatedAt: at, stageEnteredAt: at, criteria: [], plannedFiles: ['src/'], dependencies: [], evidence: [], workspaces: [], violations: [], blocker: null, lease: null,
      submission: { epoch: 1, pr: 1 }, candidate: null, observation: null, policy: { checks: [], review: true }, gates: [] } as unknown as Work;
    const inputs = kind === 'resync' ? { kind, pr: 1, sha: null, baseSha: null, baseTip: null, observedAt: null }
      : { kind, provider: 'reviewer', requestId: 'request-1', pr: 1, sha: 'a'.repeat(40), baseSha: base, policyRevision: 1 };
    const base_: NextAction = { kind, work: work.id, key: work.key, gate: 'review', refusal: 'refused', reason: `${kind} is owed`, inputs: inputs as NextAction['inputs'], llmRole: null, binding: `${kind}:1` };
    const next = () => livenessCarry(work, { gate: 'review', refusal: 'refused', action: base_, wait: null, defect: null }, [work], now()).action!;
    const tick = () => reconcileActions(work, [work], now(), { next: next() });
    const executor = { id: 'executor-1', host: 'host-1', principal: 'coordinator' };
    const rowId = actionId(kind, work.id, base_.binding);
    const reason = `${kind} refused: the provider says the pull request is locked`;
    const fail = () => {
      const taken = claimAction([work], executor, now(), { kinds: [kind] });
      assert.equal(taken?.row.id, rowId, `${kind} is offered at ${now().toISOString()}`);
      clock += 1000;
      const settled = settleAction(work, rowId, { executor: executor.id, principal: executor.principal }, 'failed', reason, now());
      tick();
      return Date.parse(settled.action.retryAt!);
    };
    tick();
    for (let failure = 1; failure < livenessRetryLimit; failure++) { clock = fail(); assert.equal(next().kind, kind, `${kind}: failure ${failure} is retried`); }
    fail();
    assert.equal(next().kind, 'escalate', `${kind}: escalated after ${livenessRetryLimit} identical refusals`);
    for (let round = 1; round <= 3; round++) {
      clock += actionStallMaxMs;
      tick();
      assert.equal(next().kind, kind, `${kind}: round ${round} retries it on the widest backoff`);
      fail();
      assert.equal(next().kind, 'escalate', `${kind}: round ${round} re-escalates on the unchanged refusal`);
    }
  }
});

test('unit:liveness-violations-detected — a pending producer request or a running proof session owns the wait on its own clock: a producer running 45 minutes inside its 120-minute timeout is not a violation, one past it is', async () => {
  const stale = await staleWait();
  assert.equal((await judge(stale)).violation?.class, 'stale-wait', 'with nothing running, an hour past stage entry is stale');
  const started = Date.now() - 45 * 60_000;
  const handle = { id: `proof-${stale.key}`, kind: 'proof', principal: 'proof-runner', epoch: null, runtime: 'claude', host: 'test', workspace: null, tab: null, pane: null, agentName: null,
    role: 'proof:integration', head: head(stale), attach: null, transcript: null, subject: 'integration proofs', startedAt: new Date(started).toISOString(), updatedAt: new Date().toISOString(), endedAt: null, state: 'running', outcome: null };
  await setDocument(stale, 'sessions', [handle]);
  const all = await store.list(), item = all.find(entry => entry.id === stale.id)!;
  const running = livenessOf(item, all, new Date());
  assert.equal(running.violation, null, `the producer inside its timeout owns the wait: ${JSON.stringify(running.violation)}`);
  assert.equal(running.obligation!.dueAt, new Date(started + 120 * 60_000).toISOString(), 'due at the end of the producer timeout, dated from the session start');
  assert.equal(livenessOf(item, all, new Date(started + 121 * 60_000)).violation?.class, 'stale-wait', 'and past it, the wait is stale');
  // A producer request pending for the head is the same obligation, dated from when it was requested.
  const requestedAt = new Date(Date.now() - 45 * 60_000).toISOString();
  await setDocument(stale, 'sessions', []);
  await setDocument(stale, 'autoDispatch', { review: null, history: [], producers: [{ id: 'request-1', kind: 'producer', group: 'integration', proofs: [PROOF], sha: head(stale), baseSha: base, policyRevision: stale.policyRevision, pr: stale.submission!.pr, requestedAt, reason: 'unproven', state: 'requested' }] });
  const requested = await judge(stale);
  assert.equal(requested.violation, null, `the pending request owns the wait: ${JSON.stringify(requested.violation)}`);
  assert.equal(requested.obligation!.dueAt, new Date(Date.parse(requestedAt) + 120 * 60_000).toISOString());
});

test('unit:unknown-merge-reconciled-from-github — a merge GitHub made on the coordinator\'s request is delivered even when a lagging read still showed the pull request open and the request was repeated before the merged observation arrived', async () => {
  let w = await candidate('pass', {}, true);
  // Published at the head of the merge queue, as the queue leaves a candidate it is about to merge.
  await setDocument(w, 'queue,speculation', { ref: `refs/graphyard/queue/${w.key.toLowerCase()}`, tip: head(w), base, baseTree: '7e'.repeat(20), predecessors: [], policyRevision: w.policyRevision, publishedAt: new Date().toISOString() });
  w = await engine.observe(w.id, (await reload(w)).revision, observation(w));
  assert.ok(w.gates.every(gate => gate.passed), `authorized to merge: ${w.gates.flatMap(gate => gate.reasons).join('; ')}`);
  const requested = await engine.requestEnqueue(coordinator, w.id, { enqueue: true, expectedRevision: (await reload(w)).revision, sha: head(w), baseSha: base, policyRevision: w.policyRevision }, id());
  // GitHub merges; its replica still answers open.
  await new Promise(resolve => setTimeout(resolve, 5));
  const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString();
  await new Promise(resolve => setTimeout(resolve, 5));
  // Another reading on the same lagging replica, and the merge step asking again on it.
  await engine.observe(w.id, (await reload(w)).revision, observation(w));
  const again = await engine.requestEnqueue(coordinator, w.id, { enqueue: true, expectedRevision: (await reload(w)).revision, sha: head(w), baseSha: base, policyRevision: w.policyRevision }, id());
  assert.deepEqual(again.enqueue, requested.enqueue, 'the standing request is returned, not a second one');
  const merged = await engine.observe(w.id, (await reload(w)).revision, observation(w, { merged: true, mergedAt, mergeSha: sha(`merge-${w.key}`) }));
  assert.equal(merged.stage, 'done', `delivered: ${merged.violations.join('; ')}`);
  assert.ok(!merged.violations.some(entry => entry.startsWith('Merge observed without a prior authorization')), 'no false unauthorized-merge violation');
  assert.equal(merged.delivery?.mergeSha, sha(`merge-${w.key}`), 'the delivery is recorded');
});

// ---- AC-3 ---------------------------------------------------------------------------------------

test('unit:liveness-count-reported — master status reports the count of liveness violations and each one\'s age, and the count is zero once the fixture board settles', async () => {
  // A board with a stranded item among healthy ones.
  await released(); await claimed(); await candidate('pass');
  const stranded = await candidate('fail');
  await strand(stranded);
  const board = { work: await store.list(), now: new Date(Date.now() + 1000).toISOString() };
  const reported = livenessStatus(board);
  assert.ok(reported.violations >= 1, 'the stranded item is counted');
  assert.equal(reported.violations, reported.items.length);
  const entry = reported.items.find(item => item.key === stranded.key)!;
  assert.equal(entry.class, 'failed-proof');
  assert.ok(entry.ageMs >= 1000 && Date.parse(entry.since) <= Date.parse(board.now), `with its age: ${JSON.stringify(entry)}`);
  assert.equal(reported.oldestMs, Math.max(...reported.items.map(item => item.ageMs)));

  // One reconciliation tick settles the board, and `master status` reports zero.
  await engine.reconcile();
  const settled = { work: await store.list(), now: new Date().toISOString() };
  assert.deepEqual(livenessStatus(settled), { violations: 0, oldestMs: null, items: [] }, 'every open item holds an obligation');

  const directory = await temporaryDirectory('liveness-status'), root = await temporaryDirectory('liveness-root');
  try {
    const credentialFile = join(directory, 'coordinator.token');
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    execFileSync('git', ['init', '-q', root]);
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), repository,
      baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
    await writeDaemonState(master, emptyDaemonState(master));
    const masterApi = async (path: string) => path === 'work-snapshot' ? settled : { decisions: [] };
    const report = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: null }) as { liveness: ReturnType<typeof livenessStatus>; counts: Record<string, number> };
    assert.equal(report.liveness.violations, 0, 'master status reports the count');
    assert.deepEqual(report.liveness.items, []);
    assert.equal(report.counts.livenessViolations, 0, 'and counts it');
    const strandedStatus = await masterStatusReport(root, master, async (path: string) => path === 'work-snapshot' ? board : { decisions: [] }, { actor: { id: 'coordinator-1' } }, { commit: null }) as typeof report;
    assert.equal(strandedStatus.liveness.violations, reported.violations, 'a board with a violation reads non-zero');
    assert.ok(strandedStatus.liveness.items.every(item => typeof item.ageMs === 'number' && item.since), 'each with its age');
  } finally { await rm(directory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});
