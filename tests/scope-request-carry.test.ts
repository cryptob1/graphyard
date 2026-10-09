import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { decisionInput } from '../src/master.js';
import { approverJudgeBoundMs, approverSettleMs, scopeRoutineDecision } from '../src/daemon/decisions.js';
import { awaitScopeOutcome } from '../src/cli/session-commands.js';
// A namespace import, so a tree without the change still loads and the case fails on what it exercises.
import * as sessionCommands from '../src/cli/session-commands.js';
import { scopeBlockedBudgetMs, scopeDecisionBinding, scopeRequestOutcome } from '../src/model/scope.js';
import { scopeAskCommand } from '../src/model/scope-provenance.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1484: a scope request stays open until its escalation decision settles. The worker's `--wait`
// lasts as long as the approver path takes, and a request whose waiting attempt ends is carried to
// the item, so the next attempt inherits the pending widening instead of losing it.
// One case per proof: unit:scope-request-wait-window, integration:scope-request-survives-epoch-end.
const repository = 'owner/scope-carry';
const operator: Principal = { id: 'carry-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'carry-implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'carry-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `scope-carry-${principal.id}-${'x'.repeat(32)}` }));
const master = { id: 'carry-master', token: `carry-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements'] };
const approver = { id: 'graphyard-approver-graphyard', token: `carry-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(credential, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const layout = 'src/widget/Layout.tsx', daemon = 'src/daemon/cycle-widget.ts';
const claim = async (id: string) => {
  const work = await engine.execute(implementer, 'claim', id, {}, randomUUID());
  return engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'carry-host', path: `/tmp/scope-carry/${work.id}-${work.epoch}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
};

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1485;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('scope-carry-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('scope_carry_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/scope_carry_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver])
    await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Scope carry fixture' });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); mock.restoreAll(); });

test('unit:scope-request-wait-window — --wait waits as long as the escalation decision pipeline needs, not the nine minutes it used to', async () => {
  // The approver judges within its bound and the loop settles the approval after it; the wait covers both, and the loop's whole promise.
  assert.ok(sessionCommands.scopeRequestWaitMs >= approverJudgeBoundMs + approverSettleMs, `${sessionCommands.scopeRequestWaitMs} covers the approver's judgement and settlement`);
  assert.ok(sessionCommands.scopeRequestWaitMs >= scopeBlockedBudgetMs, 'and the bound the loop settles any scope ask in');
  // The command's default is that window: a request still with the approver is polled past nine
  // minutes (GY-1480's approval landed at about six and a half) and reported pending only at its end.
  const start = Date.parse('2026-10-07T21:59:33.000Z');
  const request = { epoch: 1, at: new Date(start).toISOString(), paths: [daemon], reason: 'AC-3 needs the cycle module', requestedBy: implementer.id,
    decision: { state: 'refused' as const, reason: 'outside what the criteria imply', at: new Date(start).toISOString(), decidedBy: 'graphyard', waitedMs: 0, paths: [daemon], requestedBy: implementer.id, requestedAt: new Date(start).toISOString(), epoch: 1 } };
  const work = { id: 'w-1', key: 'GY-9484', plannedFiles: [layout], criteria: [{ id: 'AC-1', text: 'Renders', proofs: ['unit:x'] }], lease: { owner: implementer.id, epoch: 1, expiresAt: new Date(start + 3_600_000).toISOString() }, scopeRequest: request, scopeDecision: request.decision } as unknown as Work;
  assert.equal(scopeRequestOutcome(work, request, start).state, 'pending', 'a rule refusal with the approver is pending');
  let clock = start, polls: number[] = [];
  mock.method(Date, 'now', () => clock);
  const api = async () => { polls.push(clock - start); clock += 60_000; return { work: [work], now: new Date(clock).toISOString() }; };
  const outcome = await awaitScopeOutcome({ api } as never, work, 1, { everyMs: 0 });
  mock.restoreAll();
  assert.equal(outcome.state, 'pending');
  assert.ok(polls.some(at => at >= 540_000), `still waiting past nine minutes: ${polls.at(-1)}`);
  assert.ok(polls.at(-1)! >= sessionCommands.scopeRequestWaitMs - 60_000, `waited the whole window: ${polls.at(-1)}`);
});

test('integration:scope-request-survives-epoch-end — a request whose attempt ends while the approver judges it is carried to the item and inherited by the next attempt', async () => {
  let work = await ok(master.token, 'POST', 'work', { title: 'Carried scope ask', plannedFiles: [layout], criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }], reason: 'Scope carry fixture' }) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the attempt' }) as Work;
  work = await claim(work.id);
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [daemon], reason: 'AC-1 needs the research worktree, which only the cycle module creates' });
  // The widening rule cannot ground it, so it is the approver's; the loop routes it.
  work = await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch }) as Work;
  const asked = work.scopeRequest!;
  assert.equal(asked.decision?.state, 'refused');
  assert.equal(asked.decision?.decidedBy, 'graphyard');
  const decision = await ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'requirements', input: decisionInput('requirements', work, { plannedFiles: [layout, daemon], answers: { epoch: asked.epoch, at: asked.at } }), reason: `${work.key}: the worker asks for ${daemon}` });

  // The worker's session vanishes and its attempt ends before any approver judged the ask.
  await engine.execute(implementer, 'release', work.id, { epoch: work.epoch }, randomUUID());
  let item = await reload(work.id);
  assert.equal(item.lease, null);
  assert.equal(item.scopeRequest, null, 'the ended attempt holds no request');
  assert.deepEqual(item.carriedScopeRequest?.paths, [daemon], 'the pending widening is carried to the item');
  assert.equal(item.carriedScopeRequest?.at, asked.at);
  assert.equal(item.blocker, null, 'the rule refusal does not hold the item at the ready gate');
  const [closed] = (await store.pool.query(`SELECT payload FROM events WHERE work_id=$1 AND kind='scope.closed' ORDER BY seq DESC LIMIT 1`, [work.id])).rows;
  assert.equal(closed.payload.details.carried, true, 'the close records the carry');

  // The next attempt inherits it as its own open request, still with the approver.
  item = await claim(work.id);
  assert.equal(item.epoch, work.epoch + 1);
  assert.equal(item.carriedScopeRequest, null);
  assert.deepEqual({ epoch: item.scopeRequest?.epoch, at: item.scopeRequest?.at, paths: item.scopeRequest?.paths, decided: item.scopeRequest?.decision?.decidedBy }, { epoch: item.epoch, at: asked.at, paths: [daemon], decided: 'graphyard' });
  const snapshot = await ok(token(coordinator), 'GET', 'work-snapshot');
  assert.equal(scopeRequestOutcome(snapshot.work.find((entry: Work) => entry.id === work.id), { epoch: item.epoch, at: asked.at, paths: [daemon] }, Date.parse(snapshot.now)).state, 'pending', 'the new attempt reads it pending');

  // The approval lands on the inherited request: the widening applies and answers it.
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: decision.id, reason: 'Additive and required by AC-1' });
  item = await reload(work.id);
  assert.deepEqual(item.plannedFiles, [layout, daemon]);
  assert.equal(item.scopeRequest, null, 'the inherited request is answered');
  assert.deepEqual([item.scopeDecision?.state, item.scopeDecision?.decidedBy, item.scopeDecision?.requestedAt], ['approved', approver.id, asked.at]);
  assert.ok(item.lease && item.lease.epoch === item.epoch, 'the inheriting attempt keeps its lease');

  // A request the approver already refused is no pending widening: it closes with its attempt as before.
  let refused = await ok(master.token, 'POST', 'work', { title: 'Refused ask', plannedFiles: [layout], criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }], reason: 'Scope carry fixture' }) as Work;
  refused = await ok(master.token, 'POST', `work/${refused.id}/ready`, { expectedRevision: refused.revision, reason: 'Ready' }) as Work;
  refused = await claim(refused.id);
  await ok(token(implementer), 'POST', `work/${refused.id}/scope`, { epoch: refused.epoch, paths: [daemon], reason: 'Wanted' });
  refused = await ok(token(coordinator), 'POST', `work/${refused.id}/autoscope`, { epoch: refused.epoch }) as Work;
  const declined = await ok(master.token, 'POST', `work/${refused.id}/decide`, { action: 'requirements', input: decisionInput('requirements', refused, { plannedFiles: [layout, daemon], answers: { epoch: refused.epoch, at: refused.scopeRequest!.at } }), reason: 'The worker asks' });
  await ok(approver.token, 'POST', `work/${refused.id}/approve`, { action: 'refuse', decision: declined.id, reason: 'Not implied by the criteria' });
  await engine.execute(implementer, 'release', refused.id, { epoch: refused.epoch }, randomUUID());
  const dropped = await reload(refused.id);
  assert.equal(dropped.scopeRequest, null);
  assert.equal(dropped.carriedScopeRequest ?? null, null, 'a judged refusal is not carried');

  // A worker that reports blocked while its ask is with the approver carries it; the operator's
  // unblock then closes that carried ask on purpose, so the next claim inherits nothing (review B2).
  let unblocked = await ok(master.token, 'POST', 'work', { title: 'Unblocked carried ask', plannedFiles: [layout], criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }], reason: 'Scope carry fixture' }) as Work;
  unblocked = await ok(master.token, 'POST', `work/${unblocked.id}/ready`, { expectedRevision: unblocked.revision, reason: 'Ready' }) as Work;
  unblocked = await claim(unblocked.id);
  await ok(token(implementer), 'POST', `work/${unblocked.id}/scope`, { epoch: unblocked.epoch, paths: [daemon], reason: 'Wanted' });
  await ok(token(coordinator), 'POST', `work/${unblocked.id}/autoscope`, { epoch: unblocked.epoch });
  await engine.execute(implementer, 'blocked', unblocked.id, { epoch: unblocked.epoch, reason: 'Waiting on the widening' }, randomUUID());
  assert.deepEqual((await reload(unblocked.id)).carriedScopeRequest?.paths, [daemon], 'the blocked attempt carries its ask');
  await engine.execute(operator, 'unblock', unblocked.id, { reason: 'The operator decided the cycle module is out of scope' }, randomUUID());
  const cleared = await reload(unblocked.id);
  assert.equal(cleared.carriedScopeRequest ?? null, null, 'unblock clears the carried ask');
  const [unblockClose] = (await store.pool.query(`SELECT payload FROM events WHERE work_id=$1 AND kind='unblock' ORDER BY seq DESC LIMIT 1`, [unblocked.id])).rows;
  assert.equal(unblockClose.payload.details.closedScopeRequest?.by, 'unblock', 'the ledger records the closed carried ask');
  assert.equal((await claim(unblocked.id)).scopeRequest ?? null, null, 'the next attempt inherits nothing');
});

// GY-1568: GY-1520's worker asked for a file, the rule refused, the loop routed the ask to the
// approver — and the worker submitted 25 seconds later. The ended attempt carried the ask, but the
// loop read only live asks, so it withdrew the routed decision as one the item had moved past, and
// a master widened by hand nine minutes later: a scope-widening intervention. The carried ask now
// stays the approver's — the same decision under the same binding — and the hand widening that
// would pre-empt it is refused while the approver holds it.
test('integration:carried-scope-ask-stays-routed — an ask whose attempt ends right after asking keeps its routed decision, and no hand widening pre-empts it', async () => {
  let work = await ok(master.token, 'POST', 'work', { title: 'Ask then submit', plannedFiles: [layout], criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }], reason: 'Scope carry fixture' }) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the attempt' }) as Work;
  work = await claim(work.id);
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [daemon], reason: 'AC-1 needs the cycle module' });
  work = await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch }) as Work;
  const asked = work.scopeRequest!;
  const live = scopeRoutineDecision(work, Date.now(), true)!;
  assert.equal(live.binding, scopeDecisionBinding(asked), 'the loop routes the live ask');
  const decision = await ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'requirements', input: decisionInput('requirements', work, live.input!), reason: live.reason });

  // The attempt ends seconds later, before any approver judged the ask.
  await engine.execute(implementer, 'release', work.id, { epoch: work.epoch }, randomUUID());
  let item = await reload(work.id);
  assert.equal(item.scopeRequest, null);
  assert.equal(item.carriedScopeRequest?.at, asked.at);
  const carried = scopeRoutineDecision(item, Date.now(), true);
  assert.ok(carried, 'the carried ask is still the approver\'s: the loop still needs its decision, so it is not withdrawn');
  assert.deepEqual([carried!.binding, carried!.input], [live.binding, live.input], 'the same decision, under the same binding and input');
  assert.equal(scopeAskCommand(item, Date.now(), [{ id: decision.id, ended: false }]), `graphyard master decisions ${item.key}`, 'the board names the pending decision, not master scope');

  // A master's hand widening of the carried ask is refused while the approver holds it.
  const hand = await call(master.token, 'POST', `work/${work.id}/requirements`, { expectedPolicyRevision: item.policyRevision, criteria: item.criteria, dependencies: item.dependencies, plannedFiles: [layout, daemon], exclusiveResources: item.exclusiveResources ?? [], producerProofs: item.producerProofs ?? [], reason: 'Additive scope: the cycle module' });
  assert.equal(hand.status, 409, JSON.stringify(hand.body));
  assert.match(hand.body.error, /independent approver's to judge/);

  // The approval lands with no attempt holding the item: the widening applies and answers the carried ask.
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: decision.id, reason: 'Additive and required by AC-1' });
  item = await reload(work.id);
  assert.deepEqual(item.plannedFiles, [layout, daemon]);
  assert.equal(item.carriedScopeRequest ?? null, null, 'the carried ask is answered');
  assert.deepEqual([item.scopeDecision?.state, item.scopeDecision?.decidedBy, item.scopeDecision?.requestedAt], ['approved', approver.id, asked.at]);
  assert.equal(scopeRoutineDecision(item, Date.now(), true), null, 'nothing is left to route');
});

// GY-1568 (review): the approver's refusal of a carried ask is its answer too. It is recorded where
// `status` reads it and the carried ask is cleared, so the next claim inherits nothing to route afresh.
test('integration:carried-scope-ask-refused — the approver refusing an ask carried past its attempt clears it, so the next attempt inherits nothing', async () => {
  let work = await ok(master.token, 'POST', 'work', { title: 'Ask then release, refused', plannedFiles: [layout], criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }], reason: 'Scope carry fixture' }) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the attempt' }) as Work;
  work = await claim(work.id);
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [daemon], reason: 'Wanted' });
  work = await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch }) as Work;
  const asked = work.scopeRequest!;
  await engine.execute(implementer, 'release', work.id, { epoch: work.epoch }, randomUUID());
  let item = await reload(work.id);
  const routed = scopeRoutineDecision(item, Date.now(), true)!;
  assert.ok(routed, 'the carried ask is routed');
  const decision = await ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'requirements', input: decisionInput('requirements', item, routed.input!), reason: routed.reason });
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: decision.id, reason: 'Not implied by the criteria' });
  item = await reload(work.id);
  assert.equal(item.carriedScopeRequest ?? null, null, 'the refused carried ask is cleared');
  assert.deepEqual(item.plannedFiles, [layout]);
  assert.deepEqual([item.scopeDecision?.state, item.scopeDecision?.decidedBy, item.scopeDecision?.requestedAt, item.scopeDecision?.reason], ['refused', approver.id, asked.at, 'Not implied by the criteria']);
  assert.equal(scopeRoutineDecision(item, Date.now(), true), null, 'nothing is left to route');
  assert.equal((await claim(work.id)).scopeRequest ?? null, null, 'the next attempt inherits nothing');
});

// GY-1568 (review): a claim before the approver answers inherits the carried ask under its own
// epoch. The ask keeps the epoch that asked it, so the loop still routes the same decision — not
// withdrawn and re-asked under the new epoch — and either answer of it lands on the inherited ask.
test('integration:carried-scope-ask-claimed-before-answer — an ask a claim inherits before the approver answers keeps its routed decision, and its approval or refusal answers the inherited ask', async () => {
  for (const verdict of ['approve', 'refuse'] as const) {
    let work = await ok(master.token, 'POST', 'work', { title: `Ask, release, claim, ${verdict}`, plannedFiles: [layout], criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }], reason: 'Scope carry fixture' }) as Work;
    work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the attempt' }) as Work;
    work = await claim(work.id);
    await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [daemon], reason: 'AC-1 needs the cycle module' });
    work = await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch }) as Work;
    const asked = work.scopeRequest!, live = scopeRoutineDecision(work, Date.now(), true)!;
    const decision = await ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'requirements', input: decisionInput('requirements', work, live.input!), reason: live.reason });
    await engine.execute(implementer, 'release', work.id, { epoch: work.epoch }, randomUUID());

    // The next attempt claims before the approver judged the ask: it inherits the ask as its own.
    let item = await claim(work.id);
    assert.equal(item.epoch, asked.epoch + 1);
    assert.deepEqual([item.scopeRequest?.epoch, item.scopeRequest?.askedEpoch, item.scopeRequest?.at], [item.epoch, asked.epoch, asked.at], 'the inherited ask keeps the epoch that asked it');
    const inherited = scopeRoutineDecision(item, Date.now(), true)!;
    assert.deepEqual([inherited.binding, inherited.input], [live.binding, live.input], 'the same decision, under the same binding and input: nothing to withdraw or re-ask');
    assert.equal(scopeAskCommand(item, Date.now(), [{ id: decision.id, ended: false }]), `graphyard master decisions ${item.key}`, 'the board names the pending decision');
    const hand = await call(master.token, 'POST', `work/${work.id}/requirements`, { expectedPolicyRevision: item.policyRevision, criteria: item.criteria, dependencies: item.dependencies, plannedFiles: [layout, daemon], exclusiveResources: item.exclusiveResources ?? [], producerProofs: item.producerProofs ?? [], reason: 'Additive scope: the cycle module' });
    assert.equal(hand.status, 409, 'no hand widening pre-empts the approver');

    if (verdict === 'approve') {
      await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: decision.id, reason: 'Additive and required by AC-1' });
      item = await reload(work.id);
      assert.deepEqual(item.plannedFiles, [layout, daemon]);
      assert.equal(item.scopeRequest ?? null, null, 'the inherited ask is answered');
      assert.deepEqual([item.scopeDecision?.state, item.scopeDecision?.decidedBy, item.scopeDecision?.requestedAt], ['approved', approver.id, asked.at]);
    } else {
      await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: decision.id, reason: 'Not implied by the criteria' });
      item = await reload(work.id);
      assert.deepEqual(item.plannedFiles, [layout]);
      assert.deepEqual([item.scopeRequest?.decision?.state, item.scopeRequest?.decision?.decidedBy, item.scopeDecision?.reason], ['refused', approver.id, 'Not implied by the criteria'], 'the refusal is attached to the inherited ask');
      // As for a live ask the approver refused: its refused decision stands under the same binding, so nothing is asked anew.
      assert.equal(scopeRoutineDecision(item, Date.now(), true)?.binding, live.binding);
      continue;
    }
    assert.equal(scopeRoutineDecision(item, Date.now(), true), null, 'nothing is left to route');
  }
});
