import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal } from '../src/model.js';
import type { Observation, Work } from '../src/model/work.js';
import { foldDecisions, heldByLiveAttempt, liveLeaseRevisionRefusal, quarantinedRevisionRefusal } from '../src/model/approval.js';
import { approvalStep, approvalWatchSchema } from '../src/master-daemon.js';
import { terminalDecisions } from '../src/cli/decision-report.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2026-10-11 base only yields relative event stamps that foldDecisions and approvalStep read with an explicit now from the same base; Date.now() serves the live DB tests.

// GY-1687. A non-widening requirements revision must not change the document under a worker's feet, so
// the engine refuses it while the item holds a live lease or an unverified containment fence. Until now an
// approved decision refused for exactly that was recorded `failed` and discarded: GY-1682's decision
// 3a91b1cd was approved at 02:57:24Z and failed one second later because the rework of 02:56:14Z had just
// dispatched epoch 5, and the master had to notice, wait for the attempt to end and race the next rework
// dispatch to re-request it with a fresh approver. Such a decision is now `held`, keeps its approval, and the
// transaction that ends the attempt applies it before anything is derived from the ended attempt.

// ---- The decision fold and the loop's step ------------------------------------------------------
test('unit:requirements-decision-held-on-live-attempt — the ledger folds decision.held into a held decision that keeps its approval, and the loop neither relaunches an approver for it nor requests it again', () => {
  const id = randomUUID(), at = (offset: number) => new Date(Date.parse('2026-10-11T02:57:24Z') + offset).toISOString();
  const application = { actor: { id: 'graphyard-master', role: 'admin', sessionKind: 'ai' }, reason: 'AC-2 is a live-install rate [decision approved]' };
  const events = [
    { kind: 'decision.requested', actor: 'graphyard-master', at: at(-90_000), payload: { id, action: 'requirements', input: { expectedPolicyRevision: 3 }, reason: 'AC-2 is a live-install rate' } },
    { kind: 'decision.approved', actor: 'graphyard-approver-graphyard', at: at(0), payload: { id, action: 'requirements', reason: 'The proof can only be read post-deploy' } },
    { kind: 'decision.held', actor: 'graphyard-approver-graphyard', at: at(1_000), payload: { id, reason: `${quarantinedRevisionRefusal(5)}; the approved decision is held and applied when the attempt ends`, application } },
  ];
  const [held] = foldDecisions('work-1682', events);
  assert.equal(held.state, 'held', 'a held decision is neither approved-and-unapplied nor failed');
  assert.deepEqual([held.approvedBy, held.approvedAt, held.approvalReason], ['graphyard-approver-graphyard', at(0), 'The proof can only be read post-deploy'], 'the record keeps its approval');
  assert.match(held.outcome!, /^Task is quarantined by unverified containment from epoch 5; requirements remain immutable until settlement or stopped-worker recovery; the approved decision is held/);
  assert.deepEqual(held.held, { reason: held.outcome, at: at(1_000), application }, 'why it waits, since when, and the engine call that applies it');
  // Applied when the attempt ended: the fold moves on to applied and keeps the hold as history.
  const [applied] = foldDecisions('work-1682', [...events, { kind: 'decision.applied', actor: 'graphyard-approver-graphyard', at: at(60_000), payload: { id, outcome: 'Requirements revised to policy revision 4 when submit ended attempt 5' } }]);
  assert.equal(applied.state, 'applied');
  assert.equal(applied.held?.at, at(1_000));
  // Stale when the revision moved first: the fold must leave state stale, not held — settleHeldOnClose
  // re-folds the same ledger and would otherwise append decision.failed over the race.
  const [stale] = foldDecisions('work-1682', [...events, { kind: 'decision.stale', actor: 'graphyard', at: at(60_000), payload: { id, action: 'requirements', reason: 'Policy revision changed (now 4); the held decision was approved against revision 3 and was not applied when work.closed ended attempt 5', expected: { policyRevision: 3 }, current: { policyRevision: 4 } } }]);
  assert.equal(stale.state, 'stale');
  assert.match(stale.outcome!, /Policy revision changed \(now 4\)/);
  assert.deepEqual([stale.approvedBy, stale.approvedAt], ['graphyard-approver-graphyard', at(0)], 'the stale settlement keeps the approval');
  // Only the two live-attempt refusals hold a decision; any other refusal still fails it.
  assert.ok(heldByLiveAttempt(liveLeaseRevisionRefusal));
  assert.ok(heldByLiveAttempt(quarantinedRevisionRefusal(5)));
  assert.ok(!heldByLiveAttempt('Policy revision changed; reload before revising'));
  assert.ok(!heldByLiveAttempt('Task is quarantined by unverified containment from epoch 5'), 'the claim-time quarantine refusal is not the requirements one');
  // The loop's step: a held decision is settled for the approver's session, never a re-request, a relaunch or a wait.
  const watch = approvalWatchSchema.parse({ work: 'GY-1682', action: 'requirements', decision: id, agentName: 'graphyard-approver-gy-1682-1', requestedAt: at(-90_000), launchedAt: at(-90_000), launches: 1 });
  const step = approvalStep(watch, held, { agents: [], available: true }, Date.parse(at(600_000)));
  assert.equal(step.step, 'settled');
  assert.match(step.detail, /is approved and held \(.*requirements remain immutable.*\); the control plane applies it when the attempt ends/);
});

// ---- The control plane --------------------------------------------------------------------------
let fixture: ReturnType<typeof start> | undefined;
let teardown: (() => Promise<void>) | undefined;
after(async () => { await teardown?.(); });
const plane = () => fixture ??= start();

async function start() {
  const repository = 'owner/held-decisions';
  const operator: Principal = { id: 'held-operator', role: 'admin', sessionKind: 'human' };
  const implementer: Principal = { id: 'held-implementer', role: 'worker', sessionKind: 'ai' };
  const credentials = [operator, implementer].map(principal => ({ ...principal, token: `held-${principal.id}-${'x'.repeat(32)}` }));
  const master = { id: 'held-master', token: `held-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'policy:requirements', 'decision:rework', 'intent:unblock'] };
  const approver = { id: 'graphyard-approver-graphyard', token: `held-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve', 'policy:requirements', 'decision:rework', 'intent:ready', 'intent:unblock'] };
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1687;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('decision-held'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('held_test');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/held_test`); await store.init();
  const engine = new Engine(store, 120, repository); engine.submissionObserver = null;
  const http = server(engine, credentials);
  teardown = async () => { http.close(); await store.close(); await database.stop(); };
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const send = async (token: string, path: string, body: unknown, key: string = randomUUID()) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (token: string, path: string, body: unknown, key?: string) => {
    const result = await send(token, path, body, key);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const masterApi = async (path: string) => {
    const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${master.token}` } });
    return response.json();
  };
  const decisions = async (key: string) => ((await masterApi(`work/${key}/decisions`)) as { decisions: any[] }).decisions;
  for (const agent of [master, approver])
    await call(credentials[0].token, 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Held decision fixture' });
  const current = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
  const paths = ['src/server/routes/held-fixture.ts'];
  /** A ready item claimed by the implementer: a live attempt at epoch 1. */
  const claimed = async (title: string) => {
    let work = await call(master.token, 'work', { title, plannedFiles: paths, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Held decision fixture' }) as Work;
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    return engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  };
  /** The non-widening revision every test asks for: AC-1 restated, the same proofs, the same files. */
  const revision = (work: Work) => ({ expectedPolicyRevision: work.policyRevision, criteria: [{ id: 'AC-1', text: 'Works, as the deploy shows', proofs: ['unit:works'] }], dependencies: [], plannedFiles: paths, exclusiveResources: [] });
  /** The master requests the revision and the approver approves it; what the approval settled comes back. */
  const decided = async (work: Work) => {
    const requested = await call(master.token, `work/${work.key}/decide`, { action: 'requirements', input: revision(work), reason: 'AC-1 can only be judged on the serving release' });
    assert.equal(requested.state, 'requested');
    return call(approver.token, `work/${work.key}/approve`, { decision: requested.id, reason: 'The criterion names the deployed behaviour' });
  };
  /** Every ledger row of the item, oldest first, with the decision id each names. */
  const ledger = async (work: Work) => (await store.pool.query("SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq", [work.id])).rows as { actor: string; kind: string; payload: any }[];
  // The ledger is append-only, so time is moved instead: the control plane's clock runs `ms` ahead for the duration of `during`.
  const later = async <T>(ms: number, during: () => Promise<T>): Promise<T> => {
    const transaction = store.transaction;
    store.transaction = ((fn, options) => transaction.call(store, (db, now) => fn(db, new Date(now.getTime() + ms)), options)) as typeof transaction;
    try { return await during(); } finally { store.transaction = transaction; }
  };
  const token = (principal: Principal) => credentials.find(entry => entry.id === principal.id)!.token;
  return { engine, store, operator, implementer, master, approver, send, call, masterApi, decisions, current, claimed, revision, decided, ledger, later, paths, url, token };
}

// ---- AC-1: held, not failed ---------------------------------------------------------------------
test('unit:requirements-decision-held-on-live-attempt — an approved revision refused only by the live lease is recorded held with that reason, keeps its approval, is listed for master status, and a second request names it', { timeout: 120_000 }, async () => {
  const { engine, implementer, master, approver, send, decisions, current, claimed, revision, decided, masterApi, ledger } = await plane();
  const work = await claimed('held-on-lease');
  const settled = await decided(work);
  assert.equal(settled.state, 'held', 'the approval settles held, not failed');
  assert.equal(settled.outcome, `${liveLeaseRevisionRefusal}; the approved decision is held and applied when the attempt ends`);
  const [held] = await decisions(work.key);
  assert.deepEqual([held.state, held.approvedBy, held.approvalReason], ['held', 'graphyard-approver-graphyard', 'The criterion names the deployed behaviour'], 'the decision record keeps its approval');
  assert.ok(held.approvedAt && held.held?.at >= held.approvedAt, 'held after it was approved');
  assert.equal(held.held.application.actor.id, master.id, 'applied later as its requester, under the two-party decision');
  const item = await current(work);
  assert.equal(item.policyRevision, 1, 'nothing changed under the worker');
  assert.ok(item.lease && Date.parse(item.lease.expiresAt) > Date.now(), 'the lease stands');
  // master status: the decision is listed as held with its reason, and nothing is asked of the master for it.
  const report = await terminalDecisions(masterApi, [item], { approvals: [], runtime: { available: false, agents: [] }, now: Date.now() });
  assert.deepEqual(report.listed.filter(entry => entry.id === held.id).map(entry => [entry.state, entry.reason]), [['held', held.outcome]], 'master status lists the held decision');
  assert.ok(!report.attentionItems.some(entry => entry.text.includes(held.id)), 'a held decision needs no master attention');
  // A second request of the same action while one is held is refused naming it: the master need not re-request it.
  const repeated = await send(master.token, `work/${work.key}/decide`, { action: 'requirements', input: revision(item), reason: 'Asked again by mistake' });
  assert.equal(repeated.status, 409);
  assert.match(repeated.body.error ?? JSON.stringify(repeated.body), new RegExp(`Decision ${held.id} \\(requirements\\) on ${work.key} was approved by graphyard-approver-graphyard at .* and is held \\(.*\\); the control plane applies it in the transaction that ends the attempt, so it need not be requested again`));
  // The containment fence holds a revision the same way once the lease is gone.
  // The attempt ends between the engine's refusal and the hold's recording: the hold is judged under the item's
  // lock, so it is never recorded on an item nothing holds (one no attempt-ending transaction would ever apply it
  // on) and the approval is applied at once instead.
  const racing = await claimed('held-freed-under-refusal');
  const execute = engine.execute.bind(engine);
  let interleaved = 0;
  engine.execute = (async (...args: Parameters<typeof execute>) => {
    const [, command, id, , key] = args;
    if (command === 'requirements' && id === racing.id && key.startsWith('decision:') && !interleaved) {
      // The engine's own refusal, then the worker's release before the server can record the hold.
      try { await execute(...args); assert.fail('the live lease refuses the revision'); }
      catch (error) {
        if (!(error instanceof Error) || !heldByLiveAttempt(error.message)) throw error;
        interleaved++;
        await execute(implementer, 'release', racing.id, { epoch: racing.epoch }, randomUUID());
        throw error;
      }
    }
    return execute(...args);
  }) as typeof engine.execute;
  try {
    const applied = await decided(racing);
    assert.equal(interleaved, 1, 'the attempt ended under the refusal');
    assert.equal(applied.state, 'applied', `applied by a repeated application once the item is free: ${JSON.stringify(applied)}`);
    assert.match(applied.outcome, /^Requirements revised to policy revision 2$/);
    assert.equal((await current(racing)).policyRevision, 2);
    assert.ok(!(await ledger(racing)).some(row => row.kind === 'decision.held'), 'no hold is recorded on an item nothing holds');
  } finally { engine.execute = execute; }
  const fenced = await claimed('held-on-fence');
  const token = 'f'.repeat(64), settlementHash = createHash('sha256').update(token).digest('hex');
  await engine.execute(implementer, 'quarantine', fenced.id, { epoch: fenced.epoch, settlementHash }, randomUUID());
  await engine.execute(implementer, 'release', fenced.id, { epoch: fenced.epoch }, randomUUID());
  const fence = await current(fenced);
  assert.ok(!fence.lease && fence.containmentQuarantine, 'the lease ended; the fence is unverified');
  const settledFence = await decided(fence);
  assert.equal(settledFence.state, 'held');
  assert.equal(settledFence.outcome, `${quarantinedRevisionRefusal(1)}; the approved decision is held and applied when the attempt ends`);
  // A refusal for any other reason still fails the decision: a widening grounded on findings read for a head the item never had.
  const other = await claimed('refused-for-another-reason');
  const requested = await send(master.token, `work/${other.key}/decide`, { action: 'requirements', input: { ...revision(other), criteria: other.criteria, plannedFiles: [...other.plannedFiles!, 'src/server/routes/held-other.ts'], answers: { epoch: 1, at: new Date().toISOString(), sha: 'a'.repeat(40) } }, reason: 'A widening answering nothing' });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const failed = await send(approver.token, `work/${other.key}/approve`, { decision: requested.body.id, reason: 'Approved' });
  assert.equal(failed.body.state, 'failed', JSON.stringify(failed.body));
  assert.match(failed.body.outcome, /scope request this widening answers is no longer open/);
});

// ---- AC-2: applied by the transaction that ends the attempt -------------------------------------
test('unit:held-requirements-decision-applies-at-attempt-end — a blocked report, a lapsed lease and a containment settlement each apply the held decision at its recorded revision in the same transaction, and one whose revision moved settles stale', { timeout: 120_000 }, async () => {
  const { engine, operator, implementer, decisions, current, claimed, decided, ledger, later, paths } = await plane();
  const appliedOn = async (work: Work, how: RegExp) => {
    const item = await current(work);
    assert.equal(item.policyRevision, 2, 'applied at the revision it was approved against');
    assert.equal(item.criteria[0].text, 'Works, as the deploy shows');
    assert.equal(item.lease, null);
    const [decision] = await decisions(work.key);
    assert.equal(decision.state, 'applied', JSON.stringify(decision));
    assert.match(decision.outcome, how);
    assert.equal(decision.approvedBy, 'graphyard-approver-graphyard', 'the approval stands on the applied record');
    const rows = await ledger(work);
    const revised = rows.findIndex(row => row.kind === 'requirements'), outcome = rows.findIndex(row => row.kind === 'decision.applied' && row.payload.id === decision.id);
    assert.ok(revised >= 0 && outcome > revised, 'the revision and its outcome are written in the ending transaction');
    return { item, rows };
  };
  // A blocked report hands the item back: the decision applies in that transaction, before any dispatch is derived.
  const blocked = await claimed('held-then-blocked');
  await decided(blocked);
  await engine.execute(implementer, 'blocked', blocked.id, { epoch: blocked.epoch, reason: 'needs-decision: the criterion is unmeetable before merge' }, randomUUID());
  const { item, rows } = await appliedOn(blocked, /^Requirements revised to policy revision 2 when blocked ended attempt 1$/);
  assert.ok(rows.findIndex(row => row.kind === 'requirements') < rows.findIndex(row => row.kind === 'blocked'), 'the revision is written before the command that ended the attempt');
  assert.match(item.blocker!, /needs-decision/);
  assert.equal(item.reworkRequested, false, 'an unsubmitted item is not marked for rework');
  // A lease the worker stopped renewing lapses under reconciliation, which applies the decision as it closes the attempt.
  const lapsed = await claimed('held-then-lapsed');
  await decided(lapsed);
  await later(130_000, () => engine.reconcile());
  const { item: lapsedItem } = await appliedOn(lapsed, /^Requirements revised to policy revision 2 when attempt 1's lease lapsed$/);
  assert.equal(lapsedItem.epoch, 1);
  assert.ok((await ledger(lapsed)).some(row => row.kind === 'reconciled'), 'the reconciliation that closed the lapse wrote it');
  // A containment settlement lowers the fence that held the decision, and applies it.
  const settleable = await claimed('held-then-settled');
  const token = 'e'.repeat(64), settlementHash = createHash('sha256').update(token).digest('hex');
  await engine.execute(implementer, 'quarantine', settleable.id, { epoch: settleable.epoch, settlementHash }, randomUUID());
  await engine.execute(implementer, 'release', settleable.id, { epoch: settleable.epoch }, randomUUID());
  await decided(await current(settleable));
  await engine.execute(implementer, 'settle', settleable.id, { epoch: settleable.epoch, settlementToken: token }, randomUUID());
  const { item: settledItem } = await appliedOn(settleable, /^Requirements revised to policy revision 2 when settle ended attempt 1$/);
  assert.equal(settledItem.containmentQuarantine ?? null, null);
  // A contained attempt that submits keeps its fence until settlement (Codex review of 24a0211d59b8): the settlement that
  // frees the item applies the decision as a re-review of the submitted head, never as a rework of it.
  const contained = await claimed('held-then-submitted-then-settled');
  const containedToken = 'f'.repeat(64), containedHash = createHash('sha256').update(containedToken).digest('hex');
  await engine.execute(implementer, 'quarantine', contained.id, { epoch: contained.epoch, settlementHash: containedHash }, randomUUID());
  await engine.execute(implementer, 'workspace', contained.id, { epoch: contained.epoch, host: 'held-host', path: `/tmp/held-contained/${contained.id}`, branch: `graphyard/${contained.key.toLowerCase()}-1` }, randomUUID());
  await engine.execute(implementer, 'submit', contained.id, { epoch: contained.epoch, pr: 1688 }, randomUUID());
  assert.equal((await decided(await current(contained))).state, 'held', 'the fence of the submitted attempt holds the decision');
  await engine.execute(implementer, 'settle', contained.id, { epoch: contained.epoch, settlementToken: containedToken }, randomUUID());
  const { item: containedItem } = await appliedOn(contained, /^Requirements revised to policy revision 2 when settle ended attempt 1; the submitted head is re-reviewed on revision 2$/);
  assert.deepEqual([containedItem.submission, containedItem.reworkRequested, containedItem.formalReviewResetRequired], [{ epoch: 1, pr: 1688 }, false, true], 'the submitted head stands for re-review; it is not sent back');
  assert.equal((await ledger(contained)).find(row => row.kind === 'requirements')!.payload.details.heldDecision.resume, 'rereview');
  // A held decision whose policy revision moved first (a live widening) settles stale with the race recorded, as today.
  const widened = await claimed('held-then-widened');
  await decided(widened);
  await engine.execute(operator, 'requirements', widened.id, { expectedPolicyRevision: 1, reason: 'Widened while the worker runs', criteria: widened.criteria, dependencies: [], plannedFiles: [...paths, 'src/server/routes/held-widening.ts'], exclusiveResources: [] }, randomUUID());
  assert.equal((await current(widened)).policyRevision, 2);
  assert.ok((await current(widened)).lease, 'the widening kept the attempt');
  await engine.execute(implementer, 'release', widened.id, { epoch: widened.epoch }, randomUUID());
  const [stale] = await decisions(widened.key);
  assert.equal(stale.state, 'stale');
  assert.deepEqual(stale.race, { expected: { policyRevision: 1 }, current: { policyRevision: 2 } });
  assert.match(stale.outcome, /Policy revision changed \(now 2\); the held decision was approved against revision 1 and was not applied when release ended attempt 1/);
  assert.equal((await current(widened)).policyRevision, 2, 'the stale decision changed nothing');
  assert.equal((await current(widened)).criteria[0].text, 'Works');
});

// ---- AC-2: the endings that never enter the engine's command path, and the one that starts the next attempt ----
test('unit:held-requirements-decision-applies-at-attempt-end — a replacement claim over a lapsed lease applies the held decision before installing the new lease, and a park and a capacity exhaustion, which end the lease outside the engine, apply it in their own transaction', { timeout: 120_000 }, async () => {
  const { engine, operator, implementer, decisions, current, claimed, decided, ledger, later, call, token } = await plane();
  const applied = async (work: Work, how: RegExp) => {
    const item = await current(work);
    assert.equal(item.policyRevision, 2, 'applied at the revision it was approved against');
    assert.equal(item.criteria[0].text, 'Works, as the deploy shows');
    const [decision] = await decisions(work.key);
    assert.equal(decision.state, 'applied', JSON.stringify(decision));
    assert.match(decision.outcome, how);
    assert.equal(decision.approvedBy, 'graphyard-approver-graphyard', 'the approval stands on the applied record');
    return { item, rows: await ledger(work) };
  };
  // Codex review of 086e327d7695: a claim that arrives after the lease expired and before reconciliation closes the lapse
  // itself; it used to install the new lease over the hold, so the new worker started on the stale requirements and the
  // revision waited for that attempt to end too. The lapse is the previous attempt's end, so the decision applies there.
  const reclaimed = await claimed('held-then-reclaimed');
  await decided(reclaimed);
  const next = await later(130_000, () => engine.execute(implementer, 'claim', reclaimed.id, {}, randomUUID()));
  assert.deepEqual([next.epoch, next.lease?.epoch, next.lease?.owner, next.policyRevision, next.criteria[0].text], [2, 2, implementer.id, 2, 'Works, as the deploy shows'], 'the new attempt holds the revised item');
  const { rows: reclaimRows } = await applied(reclaimed, /^Requirements revised to policy revision 2 when attempt 1's lease lapsed$/);
  const revised = reclaimRows.findIndex(row => row.kind === 'requirements'), claim = reclaimRows.map(row => row.kind).lastIndexOf('claim');
  assert.ok(revised >= 0 && revised < claim, 'the revision is written before the claim that installed the new lease, in one transaction');
  assert.equal((next as unknown as { pipeline?: { attempts: { epoch: number; end: string | null }[] } }).pipeline?.attempts.find(attempt => attempt.epoch === 1)?.end, 'expired', 'the claim closed the lapse as the end of attempt 1');
  assert.ok(!reclaimRows.some(row => row.kind === 'decision.held' && reclaimRows.indexOf(row) > revised), 'nothing is held for the new attempt');
  // A park records a human-only decision and ends the lease in waits.ts, outside Engine.execute: the hold applies there too.
  const parked = await claimed('held-then-parked');
  await decided(parked);
  const park = await call(token(implementer), `work/${parked.key}/park`, { epoch: parked.epoch, kind: 'money-or-accounts', needed: 'A paid plan on the example provider, which only the operator may buy', reason: 'AC-1 is judged on the paid plan', recommendation: 'Buy the smallest paid plan', why: 'Nothing else exercises the criterion.' }) as Work;
  assert.ok(park.humanRequest && park.blocker, 'the item is parked for the human');
  assert.deepEqual([park.lease, park.policyRevision], [null, 2]);
  const { rows: parkRows } = await applied(parked, /^Requirements revised to policy revision 2 when human.requested ended attempt 1$/);
  assert.ok(parkRows.findIndex(row => row.kind === 'requirements') < parkRows.findIndex(row => row.kind === 'human.requested'), 'applied in the park\'s own transaction, before its history entry');
  // A worker whose account ran out mid-attempt: the coordinator's capacity report ends the lease the same way.
  const exhausted = await claimed('held-then-exhausted');
  await decided(exhausted);
  const report = await call(token(operator), `work/${exhausted.key}/capacity`, { event: 'exhausted', role: 'worker', epoch: exhausted.epoch, profile: 'alpha', account: null, runtime: 'claude', reason: 'Claude AI usage limit reached', resetsAt: null, partialWork: { state: 'clean' } }) as Work;
  assert.deepEqual([report.lease, report.policyRevision, report.capacity?.exhaustions.length], [null, 2, 1]);
  const { rows: capacityRows } = await applied(exhausted, /^Requirements revised to policy revision 2 when capacity.exhausted ended attempt 1$/);
  assert.ok(capacityRows.findIndex(row => row.kind === 'requirements') < capacityRows.findIndex(row => row.kind === 'capacity.exhausted'), 'applied in the report\'s own transaction');
  assert.ok(!(await current(exhausted)).lease, 'the item is claimable on another account');
});

// ---- AC-2: claim eligibility sees the revised requirements --------------------------------------
test('unit:held-requirements-decision-applies-at-attempt-end — a replacement claim whose held decision adds an unfinished dependency applies the revision before eligibility and refuses the claim', { timeout: 120_000 }, async () => {
  const { engine, operator, implementer, master, approver, decisions, current, claimed, later, call, paths } = await plane();
  // An unfinished dependency the held revision will add: claimable items must wait for it.
  let dependency = await call(master.token, 'work', { title: 'held-claim-dep', plannedFiles: paths, criteria: [{ id: 'AC-1', text: 'Dep', proofs: ['unit:dep'] }], reason: 'Unfinished dependency for the held revision' }) as Work;
  dependency = await engine.execute(operator, 'ready', dependency.id, {}, randomUUID());
  assert.notEqual(dependency.stage, 'done');
  // The item under a live attempt: its held revision will name that dependency.
  const work = await claimed('held-claim-precondition');
  const requested = await call(master.token, `work/${work.key}/decide`, {
    action: 'requirements',
    input: { expectedPolicyRevision: work.policyRevision, criteria: [{ id: 'AC-1', text: 'Works, as the deploy shows', proofs: ['unit:works'] }], dependencies: [dependency.id], plannedFiles: paths, exclusiveResources: [] },
    reason: 'AC-1 waits on the unfinished dependency the held revision adds',
  });
  const held = await call(approver.token, `work/${work.key}/approve`, { decision: requested.id, reason: 'The criterion names the dependency' });
  assert.equal(held.state, 'held', JSON.stringify(held));
  assert.equal((await current(work)).policyRevision, 1, 'the live attempt still holds the old requirements');
  // Before the fix, eligibility ran against the old requirements (no dependency), so the claim installed
  // epoch 2 and left the held revision for that attempt. Applying the revision first refuses the claim
  // for the unfinished dependency instead of dispatching from stale requirements.
  await assert.rejects(
    () => later(130_000, () => engine.execute(implementer, 'claim', work.id, {}, randomUUID())),
    (error: Error) => /Unfinished dependencies/.test(error.message),
    'the claim sees the revised dependencies',
  );
  const afterRefuse = await current(work);
  assert.equal(afterRefuse.lease?.epoch, 1, 'no replacement lease was installed');
  assert.equal(afterRefuse.epoch, 1, 'the claim did not open a new attempt under the stale requirements');
  assert.equal(afterRefuse.policyRevision, 1, 'the refused claim rolled back; reconciliation closes the lapse and applies the hold');
  // Reconciliation ends the lapsed attempt and applies the held revision before any later dispatch.
  await later(130_000, () => engine.reconcile());
  const item = await current(work);
  assert.equal(item.policyRevision, 2, 'reconciliation applied the held decision at the revision it was approved against');
  assert.deepEqual(item.dependencies, [dependency.id]);
  assert.equal(item.lease, null, 'the lapsed attempt ended with no replacement lease');
  const [decision] = await decisions(work.key);
  assert.equal(decision.state, 'applied', JSON.stringify(decision));
  assert.match(decision.outcome, /Requirements revised to policy revision 2 when attempt 1's lease lapsed/);
  // A later claim still sees the unfinished dependency on the revised item.
  await assert.rejects(
    () => engine.execute(implementer, 'claim', work.id, {}, randomUUID()),
    (error: Error) => /Unfinished dependencies/.test(error.message),
  );
});

// ---- AC-2: close ends a live attempt and must not leave a hold stranded --------------------------
test('unit:held-requirements-decision-applies-at-attempt-end — an approved close that ends a live lease applies the held requirements decision before the item is done', { timeout: 120_000 }, async () => {
  const { engine, operator, master, approver, decisions, current, claimed, decided, call, ledger, paths } = await plane();
  const work = await claimed('held-then-closed');
  const held = await decided(work);
  assert.equal(held.state, 'held');
  assert.equal((await current(work)).policyRevision, 1);
  // An approved close ends the live lease outside Engine.execute (closeWork). Without applying the hold
  // there, the item would go to done with the requirements decision still held forever.
  const close = await call(master.token, `work/${work.key}/decide`, { action: 'close', input: { kind: 'obsolete', expectedRevision: (await current(work)).revision }, reason: 'Nothing left to deliver on this attempt' });
  const closed = await call(approver.token, `work/${work.key}/approve`, { decision: close.id, reason: 'The follow-up owns the work' }) as { state: string; outcome: string };
  assert.equal(closed.state, 'applied', JSON.stringify(closed));
  const item = await current(work);
  assert.equal(item.stage, 'done');
  assert.equal(item.lease, null);
  assert.equal(item.policyRevision, 2, 'the held revision applied before the item was terminalized');
  assert.equal(item.criteria[0].text, 'Works, as the deploy shows');
  const [requirements] = (await decisions(work.key)).filter(entry => entry.action === 'requirements');
  assert.equal(requirements.state, 'applied', JSON.stringify(requirements));
  assert.match(requirements.outcome, /^Requirements revised to policy revision 2 when work\.closed ended attempt 1$/);
  // AC-2 race on the close path: expectedPolicyRevision moved while the attempt was live. applyHeldDecisions
  // records decision.stale; settleHeldOnClose must not re-fold that as held and append decision.failed.
  const raced = await claimed('held-then-closed-stale');
  const racedHold = await decided(raced);
  assert.equal(racedHold.state, 'held');
  await engine.execute(operator, 'requirements', raced.id, { expectedPolicyRevision: 1, reason: 'Widened while the worker runs, before close', criteria: raced.criteria, dependencies: [], plannedFiles: [...paths, 'src/server/routes/held-close-widening.ts'], exclusiveResources: [] }, randomUUID());
  assert.equal((await current(raced)).policyRevision, 2);
  assert.ok((await current(raced)).lease, 'the widening kept the attempt');
  const raceClose = await call(master.token, `work/${raced.key}/decide`, { action: 'close', input: { kind: 'obsolete', expectedRevision: (await current(raced)).revision }, reason: 'Close after the held revision raced' });
  const raceClosed = await call(approver.token, `work/${raced.key}/approve`, { decision: raceClose.id, reason: 'Nothing left under the moved revision' }) as { state: string };
  assert.equal(raceClosed.state, 'applied', JSON.stringify(raceClosed));
  const closedRaced = await current(raced);
  assert.equal(closedRaced.stage, 'done');
  assert.equal(closedRaced.policyRevision, 2, 'the stale decision changed nothing');
  assert.equal(closedRaced.criteria[0].text, 'Works');
  const [staleRequirements] = (await decisions(raced.key)).filter(entry => entry.action === 'requirements');
  assert.equal(staleRequirements.state, 'stale', JSON.stringify(staleRequirements));
  assert.deepEqual(staleRequirements.race, { expected: { policyRevision: 1 }, current: { policyRevision: 2 } });
  assert.match(staleRequirements.outcome, /Policy revision changed \(now 2\); the held decision was approved against revision 1 and was not applied when work\.closed ended attempt 1/);
  assert.ok(!(await ledger(raced)).some(row => row.kind === 'decision.failed' && row.payload.id === staleRequirements.id), 'settleHeldOnClose did not erase the stale outcome with decision.failed');
});

// ---- AC-2: the submitted head is re-reviewed on the new revision --------------------------------
test('integration:held-decision-rereviews-submitted-head — a decision held through a rework attempt applies as that attempt completes, so the submitted head is re-reviewed on the new revision instead of being reworked on the stale verdict', { timeout: 120_000 }, async () => {
  const { engine, operator, implementer, decisions, current, claimed, decided, ledger } = await plane();
  const work = await claimed('held-through-rework');
  const branch = `graphyard/${work.key.toLowerCase()}-1`, head = 'c'.repeat(40), base = 'd'.repeat(40);
  await engine.execute(implementer, 'workspace', work.id, { epoch: 1, host: 'held-host', path: `/tmp/held/${work.id}`, branch }, randomUUID());
  const submitted = await engine.execute(implementer, 'submit', work.id, { epoch: 1, pr: 1687 }, randomUUID());
  // The reviewer requested changes on the head: the stale verdict a rework would act on.
  const candidate = { sha: head, baseSha: base, pr: 1687, branch, author: implementer.id };
  await engine.observe(work.id, submitted.revision, { candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'CHANGES_REQUESTED', submittedAt: new Date().toISOString() }],
    merged: false, mergeSha: null, mergeable: true, protected: true, files: [], at: new Date().toISOString(), scopeFiles: [] } as unknown as Observation);
  await engine.execute(operator, 'rework', work.id, { reason: 'The verdict stands against the head', previousWorkerStopped: true }, randomUUID());
  const rework = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  assert.deepEqual([rework.epoch, rework.reworkRequested, !!rework.lease], [2, true, true], 'the rework attempt holds the item');
  // The requirements decision approved during the live rework attempt is held, not failed.
  const settled = await decided(rework);
  assert.equal(settled.state, 'held');
  assert.equal((await current(work)).policyRevision, 1);
  // The worker completes: the same transaction applies the decision and keeps the head for review on the new revision.
  await engine.execute(implementer, 'workspace', work.id, { epoch: 2, host: 'held-host', path: `/tmp/held-rework/${work.id}`, branch }, randomUUID());
  const completed = await engine.execute(implementer, 'submit', work.id, { epoch: 2, pr: 1687 }, randomUUID());
  assert.equal(completed.policyRevision, 2, 'applied at the revision it was approved against');
  assert.equal(completed.criteria[0].text, 'Works, as the deploy shows');
  assert.deepEqual([completed.submission, completed.lease, completed.reworkRequested], [{ epoch: 2, pr: 1687 }, null, false], 'the submitted head stands; it is not sent back for the stale verdict');
  assert.equal(completed.formalReviewResetRequired, true, 'the head needs an approval on the new revision');
  assert.equal(completed.observation, null, 'the stale verdict is no longer the item\'s observation');
  assert.ok(!completed.gates.some(gate => gate.reasons.includes('Worker has not submitted implementation for this attempt')), `no gate asks for a worker: ${JSON.stringify(completed.gates)}`);
  assert.ok(!(completed.actionQueue?.actions ?? []).some(row => row.kind === 'dispatch' || row.kind === 'request-rework'), `no rework or dispatch is derived from the ended attempt: ${JSON.stringify(completed.actionQueue?.actions)}`);
  assert.notEqual(completed.nextAction?.kind, 'dispatch');
  const [decision] = await decisions(work.key);
  assert.equal(decision.state, 'applied');
  assert.match(decision.outcome, /^Requirements revised to policy revision 2 when submit ended attempt 2; the submitted head is re-reviewed on revision 2$/);
  const rows = await ledger(work);
  const revised = rows.findIndex(row => row.kind === 'requirements'), completion = rows.map(row => row.kind).lastIndexOf('submit');
  assert.ok(revised >= 0 && revised < completion, 'the revision precedes the completion that applied it, in one transaction');
  assert.equal(rows.find(row => row.kind === 'requirements')!.payload.details.heldDecision.resume, 'rereview');
});
